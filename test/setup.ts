import 'dotenv/config';

import { afterEach } from 'vitest';

const configuredUrl = process.env.DATABASE_TEST_URL ?? process.env.DATABASE_URL;

if (configuredUrl) {
  const databaseUrl = new URL(configuredUrl);
  if (!process.env.DATABASE_TEST_URL) {
    databaseUrl.pathname = '/devin_powerapps_poc_test';
  }
  process.env.DATABASE_URL = databaseUrl.toString();

  if (process.env.DATABASE_OWNER_URL) {
    const ownerUrl = new URL(
      process.env.DATABASE_TEST_OWNER_URL ?? process.env.DATABASE_OWNER_URL,
    );
    if (!process.env.DATABASE_TEST_OWNER_URL) {
      ownerUrl.pathname = '/devin_powerapps_poc_test';
    }
    process.env.DATABASE_OWNER_URL = ownerUrl.toString();
  }
}

if (process.env.DATABASE_URL) {
  const { SYSTEM_ACTOR, withActor } = await import(
    '../packages/core/src/index.ts'
  );

  afterEach(async () => {
    await withActor(SYSTEM_ACTOR, async (client) => {
      await client.query(`
        DELETE FROM provider_calls
        WHERE refund_request_id IN (
          SELECT id FROM refund_requests
          WHERE id LIKE 'queue-%'
             OR id LIKE 'refund-sod-%'
             OR id LIKE 'refund-worker-%'
             OR id LIKE 'refund-sweeper-%'
             OR id LIKE 'in-flight-%'
             OR id LIKE 'audit-refund-%'
             OR idempotency_key LIKE 'lookup-create-%'
             OR idempotency_key LIKE 'duplicate-create-%'
             OR idempotency_key LIKE 'approval-key-%'
             OR idempotency_key LIKE 'two-reviewers-%'
             OR idempotency_key LIKE 'decision-boundaries-%'
             OR idempotency_key LIKE 'over-cap-%'
             OR idempotency_key LIKE 'at-cap-%'
        )
      `);
      await client.query(`
        DELETE FROM ledger_entries
        WHERE refund_request_id IN (
          SELECT id FROM refund_requests
          WHERE id LIKE 'queue-%'
             OR id LIKE 'refund-sod-%'
             OR id LIKE 'refund-worker-%'
             OR id LIKE 'refund-sweeper-%'
             OR id LIKE 'in-flight-%'
             OR id LIKE 'audit-refund-%'
             OR idempotency_key LIKE 'lookup-create-%'
             OR idempotency_key LIKE 'duplicate-create-%'
             OR idempotency_key LIKE 'approval-key-%'
             OR idempotency_key LIKE 'two-reviewers-%'
             OR idempotency_key LIKE 'decision-boundaries-%'
             OR idempotency_key LIKE 'over-cap-%'
             OR idempotency_key LIKE 'at-cap-%'
        )
      `);
      await client.query(`
        DELETE FROM refund_approvals
        WHERE refund_request_id IN (
          SELECT id FROM refund_requests
          WHERE id LIKE 'queue-%'
             OR id LIKE 'refund-sod-%'
             OR id LIKE 'refund-worker-%'
             OR id LIKE 'refund-sweeper-%'
             OR id LIKE 'in-flight-%'
             OR id LIKE 'audit-refund-%'
             OR idempotency_key LIKE 'lookup-create-%'
             OR idempotency_key LIKE 'duplicate-create-%'
             OR idempotency_key LIKE 'approval-key-%'
             OR idempotency_key LIKE 'two-reviewers-%'
             OR idempotency_key LIKE 'decision-boundaries-%'
             OR idempotency_key LIKE 'over-cap-%'
             OR idempotency_key LIKE 'at-cap-%'
        )
      `);
      await client.query(`
        DELETE FROM refund_requests
        WHERE id LIKE 'queue-%'
           OR id LIKE 'refund-sod-%'
           OR id LIKE 'refund-worker-%'
           OR id LIKE 'refund-sweeper-%'
           OR id LIKE 'in-flight-%'
           OR id LIKE 'audit-refund-%'
           OR idempotency_key LIKE 'lookup-create-%'
           OR idempotency_key LIKE 'duplicate-create-%'
           OR idempotency_key LIKE 'approval-key-%'
           OR idempotency_key LIKE 'two-reviewers-%'
           OR idempotency_key LIKE 'decision-boundaries-%'
           OR idempotency_key LIKE 'over-cap-%'
           OR idempotency_key LIKE 'at-cap-%'
      `);
      await client.query(`
        DELETE FROM outbox
        WHERE dedupe_key LIKE 'outbox-%'
           OR dedupe_key LIKE 'actor-context-%'
      `);
      await client.query(`
        DELETE FROM payments
        WHERE id LIKE 'audit-payment-%'
           OR id LIKE 'concurrent-payment-%'
      `);
      await client.query(`
        DELETE FROM customers
        WHERE id LIKE 'audit-customer-%'
           OR id LIKE 'concurrent-%'
      `);
      await client.query(`
        DELETE FROM users
        WHERE id LIKE 'audit-user-%'
      `);
      await client.query(`
        UPDATE payments
        SET refunded_minor = CASE id
          WHEN 'payment_1' THEN 50000
          WHEN 'payment_2' THEN 0
          WHEN 'payment_3' THEN 1000
          WHEN 'payment_4' THEN 0
          WHEN 'payment_5' THEN 25000
          WHEN 'payment_6' THEN 0
          WHEN 'payment_7' THEN 5000
        END
        WHERE id LIKE 'payment_%'
      `);
    });
  });
}
