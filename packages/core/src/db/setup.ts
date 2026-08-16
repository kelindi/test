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
    kyc_documents, kyc_cases, refund_approvals, refund_requests, payments, customers,
    users, sensitive_columns, audit_log, application_audit_events CASCADE;
  DROP FUNCTION IF EXISTS create_monthly_audit_partitions(date);
  DROP FUNCTION IF EXISTS install_audit_trigger(text);
  DROP FUNCTION IF EXISTS audit_row() CASCADE;
  DROP FUNCTION IF EXISTS append_application_audit_event(text, text, text, jsonb) CASCADE;
  DROP FUNCTION IF EXISTS validate_refund_payment() CASCADE;
  DROP FUNCTION IF EXISTS validate_payment_refunds() CASCADE;
  DROP FUNCTION IF EXISTS enqueue_outbox(text, text, jsonb) CASCADE;
  DROP FUNCTION IF EXISTS redact_snapshot(jsonb, text);
  DROP FUNCTION IF EXISTS require_actor();
  DROP FUNCTION IF EXISTS deny_audit_mutation();
  DROP SEQUENCE IF EXISTS audit_log_id_seq, application_audit_events_id_seq CASCADE;
  DROP TYPE IF EXISTS approval_decision CASCADE;
  DROP TYPE IF EXISTS refund_state CASCADE;
  DROP TYPE IF EXISTS refund_reason_code CASCADE;
  DROP TYPE IF EXISTS refund_source CASCADE;
  DROP TYPE IF EXISTS kyc_document_type CASCADE;
  DROP TYPE IF EXISTS kyc_state CASCADE;
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
   ('user_kyc', 'kyc@example.com', 'KYC Reviewer', $4, 'kyc_reviewer'),
   ('user_admin', 'admin@example.com', 'Administrator', $5, 'admin')`,
  [
    hashPassword('support-password'),
    hashPassword('finance-password'),
    hashPassword('finance-two-password'),
    hashPassword('kyc-password'),
    hashPassword('admin-password'),
  ],
);

await owner.query(
  `INSERT INTO customers (id, external_id, name, email, account_created_at)
   VALUES
     ('customer_1', 'cus_demo_1', 'Demo Customer', 'customer@example.com', now() - interval '2 years'),
     ('customer_2', 'cus_demo_2', 'Second Customer', 'second@example.com', now() - interval '18 months'),
     ('customer_3', 'cus_demo_3', 'Third Customer', 'third@example.com', now() - interval '1 year')`,
);
await owner.query(
  `INSERT INTO payments
    (id, customer_id, external_payment_id, amount_minor, refunded_minor, currency, captured_at, status)
   VALUES
     ('payment_1', 'customer_1', 'ch_demo_1', 250000, 50000, 'USD', now() - interval '30 days', 'captured'),
     ('payment_2', 'customer_1', 'ch_demo_2', 5000, 0, 'USD', now() - interval '20 days', 'captured'),
     ('payment_3', 'customer_1', 'ch_demo_3', 12500, 1000, 'USD', now() - interval '10 days', 'captured'),
     ('payment_4', 'customer_2', 'ch_demo_4', 9900, 0, 'USD', now() - interval '15 days', 'captured'),
     ('payment_5', 'customer_2', 'ch_demo_5', 75000, 25000, 'USD', now() - interval '8 days', 'captured'),
     ('payment_6', 'customer_3', 'ch_demo_6', 12000, 0, 'USD', now() - interval '6 days', 'captured'),
     ('payment_7', 'customer_3', 'ch_demo_7', 43000, 5000, 'USD', now() - interval '3 days', 'captured')`,
);

await owner.query(
  `INSERT INTO kyc_cases
    (id, customer_id, submitted_by, state, risk_level, notes, idempotency_key)
   VALUES
     ('kyc_1', 'customer_1', 'user_support', 'pending_review', 'medium',
      'Submitted for initial review', 'kyc-key-1'),
     ('kyc_2', 'customer_2', 'user_support', 'needs_more_info', 'high',
      'Address proof is blurry', 'kyc-key-2')`,
);

await owner.query(
  `INSERT INTO kyc_documents
    (id, kyc_case_id, doc_type, mock_image_path)
   VALUES
     ('doc_1', 'kyc_1', 'id_front', '/id-front.svg'),
     ('doc_2', 'kyc_1', 'id_back', '/id-back.svg'),
     ('doc_3', 'kyc_1', 'proof_of_address', '/proof-of-address.svg'),
     ('doc_4', 'kyc_1', 'selfie', '/selfie.svg'),
     ('doc_5', 'kyc_2', 'id_front', '/id-front.svg'),
     ('doc_6', 'kyc_2', 'proof_of_address', '/proof-of-address.svg')`,
);

await owner.end();
console.log('Database schema and seed are ready.');
