CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE refund_reason_code AS ENUM
  ('duplicate', 'fraud', 'customer_request', 'service_issue', 'other');
CREATE TYPE refund_state AS ENUM
  ('pending_approval', 'approved', 'executing', 'succeeded', 'failed', 'rejected', 'cancelled');
CREATE TYPE approval_decision AS ENUM ('approved', 'rejected');
CREATE TYPE refund_source AS ENUM ('manual', 'ticket', 'api');

CREATE TABLE users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('support_agent', 'finance_reviewer', 'admin')),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE customers (
  id text PRIMARY KEY,
  external_id text NOT NULL UNIQUE,
  name text NOT NULL,
  email text NOT NULL,
  account_created_at timestamptz NOT NULL
);

CREATE TABLE payments (
  id text PRIMARY KEY,
  customer_id text NOT NULL REFERENCES customers(id),
  external_payment_id text NOT NULL UNIQUE,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  refunded_minor bigint NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
  currency text NOT NULL,
  captured_at timestamptz NOT NULL,
  status text NOT NULL,
  UNIQUE (id, customer_id)
);

CREATE TABLE refund_requests (
  id text PRIMARY KEY,
  customer_id text NOT NULL REFERENCES customers(id),
  payment_id text NOT NULL REFERENCES payments(id),
  payment_snapshot jsonb NOT NULL,
  requested_by text NOT NULL REFERENCES users(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL,
  reason_code refund_reason_code NOT NULL,
  notes text,
  state refund_state NOT NULL,
  source refund_source NOT NULL DEFAULT 'manual',
  external_reference text,
  idempotency_key text NOT NULL UNIQUE,
  FOREIGN KEY (customer_id, payment_id) REFERENCES payments(customer_id, id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (reason_code <> 'other' OR NULLIF(btrim(notes), '') IS NOT NULL)
);

CREATE OR REPLACE FUNCTION validate_refund_payment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  payment_record record;
BEGIN
  SELECT amount_minor, currency INTO payment_record
  FROM payments
  WHERE id = NEW.payment_id AND customer_id = NEW.customer_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'refund payment does not belong to customer';
  END IF;
  IF NEW.currency <> payment_record.currency THEN
    RAISE EXCEPTION 'refund currency must match payment currency';
  END IF;
  IF NEW.amount_minor > payment_record.amount_minor THEN
    RAISE EXCEPTION 'refund amount exceeds payment amount';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER refund_payment_invariants
BEFORE INSERT OR UPDATE OF customer_id, payment_id, amount_minor, currency
ON refund_requests
FOR EACH ROW EXECUTE FUNCTION validate_refund_payment();

CREATE OR REPLACE FUNCTION validate_payment_refunds()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM refund_requests
    WHERE payment_id = NEW.id
      AND (currency <> NEW.currency OR amount_minor > NEW.amount_minor)
  ) THEN
    RAISE EXCEPTION 'payment update would invalidate an existing refund';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payment_refund_invariants
AFTER UPDATE OF amount_minor, currency ON payments
FOR EACH ROW EXECUTE FUNCTION validate_payment_refunds();

CREATE TABLE refund_approvals (
  id serial PRIMARY KEY,
  refund_request_id text NOT NULL REFERENCES refund_requests(id),
  approver_id text NOT NULL REFERENCES users(id),
  decision approval_decision NOT NULL,
  reason_code refund_reason_code NOT NULL,
  comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (refund_request_id, approver_id)
);

CREATE TABLE ledger_entries (
  id serial PRIMARY KEY,
  refund_request_id text NOT NULL REFERENCES refund_requests(id),
  payment_id text NOT NULL REFERENCES payments(id),
  amount_minor bigint NOT NULL,
  currency text NOT NULL,
  direction text NOT NULL CHECK (direction = 'debit'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (refund_request_id)
);

CREATE TABLE outbox (
  id serial PRIMARY KEY,
  kind text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION enqueue_outbox(
  outbox_kind text,
  outbox_dedupe_key text,
  outbox_payload jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  outbox_id integer;
BEGIN
  INSERT INTO outbox (kind, dedupe_key, payload)
  VALUES (outbox_kind, outbox_dedupe_key, outbox_payload)
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING id INTO outbox_id;
  IF outbox_id IS NULL THEN
    SELECT id INTO outbox_id FROM outbox WHERE dedupe_key = outbox_dedupe_key;
  END IF;
  RETURN outbox_id;
END;
$$;

CREATE TABLE provider_calls (
  id serial PRIMARY KEY,
  refund_request_id text NOT NULL REFERENCES refund_requests(id),
  idempotency_key text NOT NULL UNIQUE,
  request_payload jsonb NOT NULL,
  response_payload jsonb,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE access_log (
  id serial PRIMARY KEY,
  actor_id text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sensitive_columns (
  table_name text NOT NULL,
  column_name text NOT NULL,
  sensitivity text NOT NULL CHECK (sensitivity IN ('public', 'internal', 'sensitive')),
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

CREATE TABLE application_audit_events (
  id bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  event_type text NOT NULL,
  actor_id text NOT NULL,
  request_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  prev_hash text NOT NULL,
  row_hash text NOT NULL,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE audit_log_default PARTITION OF audit_log DEFAULT;
CREATE TABLE application_audit_events_default PARTITION OF application_audit_events DEFAULT;
CREATE SEQUENCE audit_log_id_seq;
CREATE SEQUENCE application_audit_events_id_seq;

INSERT INTO sensitive_columns VALUES
  ('users', 'email', 'sensitive', true),
  ('customers', 'name', 'sensitive', true),
  ('customers', 'email', 'sensitive', true),
  ('refund_requests', 'notes', 'internal', false),
  ('refund_approvals', 'comment', 'internal', false);

CREATE OR REPLACE FUNCTION create_monthly_audit_partitions(month_start date)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  next_month date := (month_start + interval '1 month')::date;
  audit_partition text := format('audit_log_%s', to_char(month_start, 'YYYY_MM'));
  application_partition text := format('application_audit_events_%s', to_char(month_start, 'YYYY_MM'));
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF audit_log FOR VALUES FROM (%L) TO (%L)',
    audit_partition, month_start, next_month
  );
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF application_audit_events FOR VALUES FROM (%L) TO (%L)',
    application_partition, month_start, next_month
  );
END;
$$;

SELECT create_monthly_audit_partitions(date_trunc('month', current_date)::date);
SELECT create_monthly_audit_partitions((date_trunc('month', current_date) + interval '1 month')::date);

CREATE OR REPLACE FUNCTION require_actor()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NULLIF(current_setting('app.current_actor_id', true), '') IS NULL
     OR NULLIF(current_setting('app.request_id', true), '') IS NULL THEN
    RAISE EXCEPTION 'actor and request id must be set before database access';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION redact_snapshot(input jsonb, target_table text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  item record;
  result jsonb := input;
BEGIN
  IF input IS NULL THEN RETURN NULL; END IF;
  FOR item IN
    SELECT column_name FROM sensitive_columns
    WHERE table_name = target_table AND redact_in_audit
  LOOP
    result := result - item.column_name;
  END LOOP;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION audit_row()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  old_json jsonb;
  new_json jsonb;
  row_pk text;
  previous_hash text;
  content text;
BEGIN
  PERFORM require_actor();
  old_json := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN redact_snapshot(to_jsonb(OLD), TG_TABLE_NAME) ELSE NULL END;
  new_json := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN redact_snapshot(to_jsonb(NEW), TG_TABLE_NAME) ELSE NULL END;
  row_pk := COALESCE(new_json->>'id', old_json->>'id', new_json->>'refund_request_id', old_json->>'refund_request_id');

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

CREATE OR REPLACE FUNCTION deny_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit records are append-only';
END;
$$;

CREATE OR REPLACE FUNCTION install_audit_trigger(table_name text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS %I_audit ON %I', table_name, table_name);
  EXECUTE format(
    'CREATE TRIGGER %I_audit AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()',
    table_name, table_name
  );
END;
$$;

SELECT install_audit_trigger('users');
SELECT install_audit_trigger('customers');
SELECT install_audit_trigger('payments');
SELECT install_audit_trigger('refund_requests');
SELECT install_audit_trigger('refund_approvals');
SELECT install_audit_trigger('ledger_entries');
SELECT install_audit_trigger('outbox');
SELECT install_audit_trigger('provider_calls');
SELECT install_audit_trigger('access_log');

CREATE TRIGGER audit_log_immutable
BEFORE UPDATE OR DELETE ON audit_log
FOR EACH ROW EXECUTE FUNCTION deny_audit_mutation();
CREATE TRIGGER application_audit_events_immutable
BEFORE UPDATE OR DELETE ON application_audit_events
FOR EACH ROW EXECUTE FUNCTION deny_audit_mutation();

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments FORCE ROW LEVEL SECURITY;
ALTER TABLE refund_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE refund_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE refund_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE refund_approvals FORCE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE provider_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_calls FORCE ROW LEVEL SECURITY;
ALTER TABLE access_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_log FORCE ROW LEVEL SECURITY;

CREATE POLICY users_admin ON users
  USING (current_setting('app.current_actor_role', true) = 'admin');
CREATE POLICY customers_all_roles ON customers
  USING (current_setting('app.current_actor_role', true) IN ('support_agent', 'finance_reviewer', 'admin'));
CREATE POLICY payments_all_roles ON payments
  USING (current_setting('app.current_actor_role', true) IN ('support_agent', 'finance_reviewer', 'admin'));
CREATE POLICY payments_owner_invariants ON payments
  FOR SELECT TO devin_powerapps_owner
  USING (true);
CREATE POLICY refunds_all_roles ON refund_requests
  USING (current_setting('app.current_actor_role', true) IN ('support_agent', 'finance_reviewer', 'admin'));
CREATE POLICY refunds_owner_invariants ON refund_requests
  FOR SELECT TO devin_powerapps_owner
  USING (true);
CREATE POLICY approvals_finance ON refund_approvals
  USING (current_setting('app.current_actor_role', true) IN ('support_agent', 'finance_reviewer', 'admin'));
CREATE POLICY ledger_finance ON ledger_entries
  USING (current_setting('app.current_actor_role', true) IN ('finance_reviewer', 'admin'));
CREATE POLICY outbox_admin ON outbox
  USING (current_setting('app.current_actor_role', true) = 'admin');
CREATE POLICY outbox_owner_enqueue ON outbox
  FOR INSERT TO devin_powerapps_owner
  WITH CHECK (true);
CREATE POLICY outbox_owner_dedupe_read ON outbox
  FOR SELECT TO devin_powerapps_owner
  USING (true);
CREATE POLICY provider_calls_finance ON provider_calls
  USING (current_setting('app.current_actor_role', true) IN ('finance_reviewer', 'admin'));
CREATE POLICY access_log_admin ON access_log
  USING (current_setting('app.current_actor_role', true) = 'admin');
CREATE POLICY access_log_insert ON access_log
  FOR INSERT
  WITH CHECK (actor_id = current_setting('app.current_actor_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON users, customers, payments, refund_requests,
  refund_approvals, ledger_entries, provider_calls TO devin_powerapps_app;
GRANT SELECT, UPDATE, DELETE ON outbox TO devin_powerapps_app;
REVOKE INSERT ON outbox FROM devin_powerapps_app;
GRANT EXECUTE ON FUNCTION enqueue_outbox(text, text, jsonb) TO devin_powerapps_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON access_log TO devin_powerapps_app;
GRANT SELECT, INSERT ON application_audit_events TO devin_powerapps_app;
GRANT SELECT ON audit_log, sensitive_columns TO devin_powerapps_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO devin_powerapps_app;
