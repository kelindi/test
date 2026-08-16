CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('support_agent', 'finance_reviewer', 'admin'))
);

CREATE TABLE customers (
  id text PRIMARY KEY,
  name text NOT NULL,
  account_created_at timestamptz NOT NULL
);

CREATE TABLE payments (
  id text PRIMARY KEY,
  customer_id text NOT NULL REFERENCES customers(id),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  refunded_minor bigint NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
  currency text NOT NULL
);

CREATE TABLE refund_requests (
  id text PRIMARY KEY,
  customer_id text NOT NULL REFERENCES customers(id),
  payment_id text NOT NULL REFERENCES payments(id),
  requester_id text NOT NULL REFERENCES users(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL,
  reason_code text NOT NULL CHECK (reason_code IN ('duplicate', 'fraud', 'customer_request', 'service_issue')),
  notes text,
  state text NOT NULL CHECK (state IN ('draft', 'pending_approval', 'approved', 'executing', 'succeeded', 'failed', 'rejected', 'cancelled')),
  approvals jsonb NOT NULL DEFAULT '[]',
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger (
  id serial PRIMARY KEY,
  refund_id text NOT NULL UNIQUE REFERENCES refund_requests(id),
  payment_id text NOT NULL REFERENCES payments(id),
  amount_minor bigint NOT NULL,
  currency text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outbox (
  id serial PRIMARY KEY,
  kind text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE application_audit_events (
  id serial PRIMARY KEY,
  event_type text NOT NULL,
  actor_id text NOT NULL,
  request_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sensitive_columns (
  table_name text NOT NULL,
  column_name text NOT NULL,
  sensitivity text NOT NULL,
  redact_in_audit boolean NOT NULL DEFAULT false,
  PRIMARY KEY (table_name, column_name)
);

CREATE TABLE audit_log (
  id bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  table_name text NOT NULL,
  row_pk text NOT NULL,
  operation text NOT NULL,
  before_data jsonb,
  after_data jsonb,
  actor_id text NOT NULL,
  request_id text NOT NULL,
  prev_hash text NOT NULL,
  row_hash text NOT NULL,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE audit_log_default PARTITION OF audit_log DEFAULT;
CREATE SEQUENCE audit_log_id_seq;

INSERT INTO sensitive_columns VALUES
  ('users', 'email', 'personal', true),
  ('customers', 'name', 'personal', true),
  ('refund_requests', 'notes', 'confidential', true);

CREATE OR REPLACE FUNCTION require_actor() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF current_setting('app.current_actor_id', true) IS NULL
     OR current_setting('app.current_actor_id', true) = ''
     OR current_setting('app.request_id', true) IS NULL
     OR current_setting('app.request_id', true) = '' THEN
    RAISE EXCEPTION 'actor and request id must be set before database access';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION audit_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  old_json jsonb;
  new_json jsonb;
  row_pk text;
  previous_hash text;
  content text;
  column_record record;
BEGIN
  PERFORM require_actor();
  old_json := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) ELSE NULL END;
  new_json := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) ELSE NULL END;

  row_pk := COALESCE(new_json->>'id', old_json->>'id', new_json->>'refund_id', old_json->>'refund_id');

  FOR column_record IN
    SELECT column_name
    FROM sensitive_columns
    WHERE table_name = TG_TABLE_NAME AND redact_in_audit
  LOOP
    old_json := CASE WHEN old_json IS NULL THEN NULL ELSE old_json - column_record.column_name END;
    new_json := CASE WHEN new_json IS NULL THEN NULL ELSE new_json - column_record.column_name END;
  END LOOP;

  PERFORM pg_advisory_xact_lock(78123);
  SELECT row_hash INTO previous_hash FROM audit_log ORDER BY id DESC LIMIT 1;
  previous_hash := COALESCE(previous_hash, '');
  content := json_build_object(
    'tableName', TG_TABLE_NAME,
    'rowPk', row_pk,
    'operation', TG_OP,
    'beforeData', old_json,
    'afterData', new_json,
    'actorId', current_setting('app.current_actor_id'),
    'requestId', current_setting('app.request_id'),
    'prevHash', previous_hash
  )::text;

  INSERT INTO audit_log (
    id, table_name, row_pk, operation, before_data, after_data,
    actor_id, request_id, prev_hash, row_hash
  ) VALUES (
    nextval('audit_log_id_seq'), TG_TABLE_NAME, row_pk, TG_OP, old_json, new_json,
    current_setting('app.current_actor_id'), current_setting('app.request_id'),
    previous_hash, encode(digest(content, 'sha256'), 'hex')
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION deny_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit records are append-only';
END;
$$;

CREATE OR REPLACE FUNCTION install_audit_trigger(table_name text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS %I_audit ON %I', table_name, table_name);
  EXECUTE format(
    'CREATE TRIGGER %I_audit AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()',
    table_name,
    table_name
  );
END;
$$;

SELECT install_audit_trigger('users');
SELECT install_audit_trigger('customers');
SELECT install_audit_trigger('payments');
SELECT install_audit_trigger('refund_requests');
SELECT install_audit_trigger('ledger');
SELECT install_audit_trigger('outbox');

CREATE TRIGGER audit_log_immutable
BEFORE UPDATE OR DELETE ON audit_log
FOR EACH ROW EXECUTE FUNCTION deny_audit_mutation();

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments FORCE ROW LEVEL SECURITY;
ALTER TABLE refund_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE refund_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger FORCE ROW LEVEL SECURITY;
ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox FORCE ROW LEVEL SECURITY;

CREATE POLICY users_admin ON users
  USING (current_setting('app.current_actor_role', true) = 'admin');
CREATE POLICY customers_visible ON customers
  USING (current_setting('app.current_actor_role', true) IN ('support_agent', 'finance_reviewer', 'admin'));
CREATE POLICY payments_visible ON payments
  USING (current_setting('app.current_actor_role', true) IN ('support_agent', 'finance_reviewer', 'admin'));
CREATE POLICY refunds_support_own ON refund_requests
  USING (
    current_setting('app.current_actor_role', true) = 'admin'
    OR current_setting('app.current_actor_role', true) = 'finance_reviewer'
    OR (
      current_setting('app.current_actor_role', true) = 'support_agent'
      AND requester_id = current_setting('app.current_actor_id', true)
    )
  );
CREATE POLICY ledger_finance ON ledger
  USING (current_setting('app.current_actor_role', true) IN ('finance_reviewer', 'admin'));
CREATE POLICY outbox_admin ON outbox
  USING (current_setting('app.current_actor_role', true) = 'admin');

GRANT SELECT, INSERT, UPDATE, DELETE ON users, customers, payments, refund_requests, ledger, outbox TO devin_powerapps_app;
GRANT SELECT ON audit_log, application_audit_events, sensitive_columns TO devin_powerapps_app;
GRANT INSERT ON application_audit_events TO devin_powerapps_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO devin_powerapps_app;
