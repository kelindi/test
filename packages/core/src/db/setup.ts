import 'dotenv/config';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const owner = new pg.Client({
  connectionString: process.env.DATABASE_OWNER_URL,
});
await owner.connect();
await owner.query(`
  DROP TABLE IF EXISTS access_log, provider_calls, outbox, ledger_entries, ledger,
    refund_approvals, refund_requests, payments, customers, users,
    sensitive_columns, audit_log, application_audit_events CASCADE;
  DROP FUNCTION IF EXISTS create_monthly_audit_partitions(date);
  DROP FUNCTION IF EXISTS install_audit_trigger(text);
  DROP FUNCTION IF EXISTS audit_row() CASCADE;
  DROP FUNCTION IF EXISTS redact_snapshot(jsonb, text);
  DROP FUNCTION IF EXISTS require_actor();
  DROP FUNCTION IF EXISTS deny_audit_mutation();
  DROP SEQUENCE IF EXISTS audit_log_id_seq, application_audit_events_id_seq CASCADE;
  DROP TYPE IF EXISTS approval_decision CASCADE;
  DROP TYPE IF EXISTS refund_state CASCADE;
  DROP TYPE IF EXISTS refund_reason_code CASCADE;
`);
await owner.query(
  fs.readFileSync(path.join(process.cwd(), 'drizzle/0000_initial.sql'), 'utf8'),
);

await owner.query(
  "SELECT set_config('app.current_actor_id', 'seed', false), set_config('app.current_actor_role', 'admin', false), set_config('app.request_id', 'seed', false)",
);

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

await owner.query(
  `INSERT INTO users (id, email, name, password_hash, role) VALUES
   ('user_support', 'support@example.com', 'Support Agent', $1, 'support_agent'),
   ('user_finance_1', 'finance1@example.com', 'Finance Reviewer One', $2, 'finance_reviewer'),
   ('user_finance_2', 'finance2@example.com', 'Finance Reviewer Two', $3, 'finance_reviewer'),
   ('user_admin', 'admin@example.com', 'Administrator', $4, 'admin')`,
  [
    hashPassword('support-password'),
    hashPassword('finance-password'),
    hashPassword('finance-two-password'),
    hashPassword('admin-password'),
  ],
);

await owner.query(
  `INSERT INTO customers (id, external_id, name, email, account_created_at)
   VALUES ('customer_1', 'cus_demo_1', 'Demo Customer', 'customer@example.com', now() - interval '2 years')`,
);
await owner.query(
  `INSERT INTO payments
    (id, customer_id, external_payment_id, amount_minor, refunded_minor, currency, captured_at, status)
   VALUES ('payment_1', 'customer_1', 'ch_demo_1', 250000, 0, 'USD', now() - interval '30 days', 'captured')`,
);

await owner.end();
console.log('Database schema and seed are ready.');
