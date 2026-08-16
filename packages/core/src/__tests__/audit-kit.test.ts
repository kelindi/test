import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { SYSTEM_ACTOR, verifyAuditChain, withActor } from '..';

const runWithDatabase = describe.runIf(Boolean(process.env.DATABASE_URL));

runWithDatabase('auditor-facing audit completeness kit', () => {
  it('audits INSERT UPDATE DELETE for every business table and preserves justifications', async () => {
    const suffix = crypto.randomUUID();
    const ids = {
      user: `audit-user-${suffix}`,
      customer: `audit-customer-${suffix}`,
      payment: `audit-payment-${suffix}`,
      refund: `audit-refund-${suffix}`,
      key: `audit-key-${suffix}`,
    };

    await withActor(SYSTEM_ACTOR, async (client) => {
      await client.query(
        `INSERT INTO users (id, email, name, password_hash, role)
         VALUES ($1, $2, 'Audit User', 'salt:hash', 'admin')`,
        [ids.user, `${suffix}@example.com`],
      );
      await client.query(
        `INSERT INTO customers
          (id, external_id, name, email, account_created_at)
         VALUES ($1, $2, 'Audit Customer', $3, now())`,
        [ids.customer, `external-${suffix}`, `${suffix}@customer.example`],
      );
      await client.query(
        `INSERT INTO payments
          (id, customer_id, external_payment_id, amount_minor, currency, captured_at, status)
         VALUES ($1, $2, $3, 100, 'USD', now(), 'captured')`,
        [ids.payment, ids.customer, `charge-${suffix}`],
      );
      await client.query(
        `INSERT INTO refund_requests
          (id, customer_id, payment_id, payment_snapshot, requested_by,
           amount_minor, currency, reason_code, notes, state, idempotency_key)
         VALUES ($1, $2, $3, '{}', $4, 1, 'USD', 'other', 'audit justification',
                 'pending_approval', $5)`,
        [ids.refund, ids.customer, ids.payment, ids.user, ids.key],
      );
      const approval = (
        await client.query(
          `INSERT INTO refund_approvals
            (refund_request_id, approver_id, decision, reason_code, comment)
           VALUES ($1, $2, 'approved', 'other', 'review justification')
           RETURNING id`,
          [ids.refund, ids.user],
        )
      ).rows[0].id;
      const ledger = (
        await client.query(
          `INSERT INTO ledger_entries
            (refund_request_id, payment_id, amount_minor, currency, direction)
           VALUES ($1, $2, 1, 'USD', 'debit') RETURNING id`,
          [ids.refund, ids.payment],
        )
      ).rows[0].id;
      const outbox = (
        await client.query(
          `SELECT enqueue_outbox('audit.test', $1, '{}') AS id`,
          [`outbox-${suffix}`],
        )
      ).rows[0].id;
      const providerCall = (
        await client.query(
          `INSERT INTO provider_calls
            (refund_request_id, idempotency_key, request_payload, status)
           VALUES ($1, $2, '{}', 'pending') RETURNING id`,
          [ids.refund, `provider-${suffix}`],
        )
      ).rows[0].id;
      const access = (
        await client.query(
          `INSERT INTO access_log (actor_id, resource_type, resource_id, request_id)
           VALUES ($1, 'refund_request', $2, $3) RETURNING id`,
          [ids.user, ids.refund, suffix],
        )
      ).rows[0].id;

      await client.query('UPDATE users SET name = $1 WHERE id = $2', [
        'Audit User Updated',
        ids.user,
      ]);
      await client.query('UPDATE customers SET name = $1 WHERE id = $2', [
        'Audit Customer Updated',
        ids.customer,
      ]);
      await client.query('UPDATE payments SET status = $1 WHERE id = $2', [
        'updated',
        ids.payment,
      ]);
      await client.query(
        'UPDATE refund_requests SET notes = $1 WHERE id = $2',
        ['updated justification', ids.refund],
      );
      await client.query(
        'UPDATE refund_approvals SET comment = $1 WHERE id = $2',
        ['updated review', approval],
      );
      await client.query(
        'UPDATE ledger_entries SET amount_minor = 2 WHERE id = $1',
        [ledger],
      );
      await client.query('UPDATE outbox SET last_error = $1 WHERE id = $2', [
        'updated',
        outbox,
      ]);
      await client.query(
        'UPDATE provider_calls SET status = $1 WHERE id = $2',
        ['updated', providerCall],
      );
      await client.query(
        'UPDATE access_log SET resource_type = $1 WHERE id = $2',
        ['refund', access],
      );

      await client.query('DELETE FROM access_log WHERE id = $1', [access]);
      await client.query('DELETE FROM provider_calls WHERE id = $1', [
        providerCall,
      ]);
      await client.query('DELETE FROM outbox WHERE id = $1', [outbox]);
      await client.query('DELETE FROM ledger_entries WHERE id = $1', [ledger]);
      await client.query('DELETE FROM refund_approvals WHERE id = $1', [
        approval,
      ]);
      await client.query('DELETE FROM refund_requests WHERE id = $1', [
        ids.refund,
      ]);
      await client.query('DELETE FROM payments WHERE id = $1', [ids.payment]);
      await client.query('DELETE FROM customers WHERE id = $1', [ids.customer]);
      await client.query('DELETE FROM users WHERE id = $1', [ids.user]);
    });

    const rows = (
      await withActor(SYSTEM_ACTOR, (client) =>
        client.query(
          `SELECT table_name, row_pk, operation, before_data, after_data
           FROM audit_log
           WHERE actor_id = $1
             AND created_at > now() - interval '10 seconds'`,
          [SYSTEM_ACTOR.id],
        ),
      )
    ).rows;

    for (const tableName of [
      'users',
      'customers',
      'payments',
      'refund_requests',
      'refund_approvals',
      'ledger_entries',
      'outbox',
      'provider_calls',
      'access_log',
    ]) {
      const tableRows = rows.filter((row) => row.table_name === tableName);
      expect(tableRows.length, tableName).toBeGreaterThanOrEqual(3);
      expect(tableRows.map((row) => row.operation)).toEqual(
        expect.arrayContaining(['INSERT', 'UPDATE', 'DELETE']),
      );
    }

    const customerInsert = rows.find(
      (row) => row.table_name === 'customers' && row.operation === 'INSERT',
    );
    const refundInsert = rows.find(
      (row) =>
        row.table_name === 'refund_requests' && row.operation === 'INSERT',
    );
    expect(customerInsert.after_data.email).toBeUndefined();
    expect(customerInsert.after_data.name).toBeUndefined();
    const userInsert = rows.find(
      (row) => row.table_name === 'users' && row.operation === 'INSERT',
    );
    expect(userInsert.after_data.password_hash).toBeUndefined();
    expect(refundInsert.after_data.notes).toBe('audit justification');
    expect(await verifyAuditChain()).toBe(true);
  });

  it('enforces wrong-role RLS visibility at the database layer', async () => {
    const support = { id: 'user_support', role: 'support_agent' as const };
    const rows = await withActor(support, async (client) => ({
      users: (await client.query('SELECT id FROM users')).rows,
      ledger: (await client.query('SELECT id FROM ledger_entries')).rows,
      providerCalls: (await client.query('SELECT id FROM provider_calls')).rows,
      outbox: (await client.query('SELECT id FROM outbox')).rows,
    }));
    expect(rows.users).toHaveLength(0);
    expect(rows.ledger).toHaveLength(0);
    expect(rows.providerCalls).toHaveLength(0);
    expect(rows.outbox).toHaveLength(0);
  });

  it('prevents the app role from mutating append-only audit tables', async () => {
    const pg = (await import('pg')).default;
    const client = new pg.Client({
      connectionString: process.env.DATABASE_URL,
    });
    await client.connect();
    await expect(
      client.query(
        `UPDATE audit_log SET row_hash = 'tampered'
         WHERE id = (SELECT id FROM audit_log LIMIT 1)`,
      ),
    ).rejects.toThrow();
    await client.end();
  });

  it('enforces one approval per reviewer and serializes concurrent outbox claims', async () => {
    const suffix = crypto.randomUUID();
    const refundId = `refund-sod-${suffix}`;
    const outboxKey = `outbox-concurrent-${suffix}`;
    await withActor(SYSTEM_ACTOR, async (client) => {
      await client.query(
        `INSERT INTO refund_requests
          (id, customer_id, payment_id, payment_snapshot, requested_by,
           amount_minor, currency, reason_code, notes, state, idempotency_key)
         VALUES ($1, 'customer_1', 'payment_1', '{}', 'user_support',
                 1, 'USD', 'other', 'SoD test', 'pending_approval', $2)`,
        [refundId, `refund-key-${suffix}`],
      );
      await client.query(
        `INSERT INTO refund_approvals
          (refund_request_id, approver_id, decision, reason_code)
         VALUES ($1, 'user_finance_1', 'approved', 'other')`,
        [refundId],
      );
    });
    await expect(
      withActor(SYSTEM_ACTOR, (client) =>
        client.query(
          `INSERT INTO refund_approvals
            (refund_request_id, approver_id, decision, reason_code)
           VALUES ($1, 'user_finance_1', 'approved', 'other')`,
          [refundId],
        ),
      ),
    ).rejects.toThrow(/unique/i);
    await withActor(SYSTEM_ACTOR, async (client) => {
      await client.query(`SELECT enqueue_outbox('claim.test', $1, '{}')`, [
        outboxKey,
      ]);
    });

    const claimed = await Promise.all(
      Array.from({ length: 3 }, () =>
        withActor(SYSTEM_ACTOR, async (client) => {
          const result = await client.query(
            `SELECT * FROM outbox
             WHERE dedupe_key = $1 AND status = 'pending'
             FOR UPDATE SKIP LOCKED`,
            [outboxKey],
          );
          const item = result.rows[0];
          if (item) {
            await client.query(
              "UPDATE outbox SET status = 'processing' WHERE id = $1",
              [item.id],
            );
          }
          return item;
        }),
      ),
    );
    expect(claimed.filter(Boolean)).toHaveLength(1);
    await withActor(SYSTEM_ACTOR, async (client) => {
      await client.query('DELETE FROM outbox WHERE dedupe_key = $1', [
        outboxKey,
      ]);
      await client.query(
        'DELETE FROM refund_approvals WHERE refund_request_id = $1',
        [refundId],
      );
      await client.query('DELETE FROM refund_requests WHERE id = $1', [
        refundId,
      ]);
    });
  });
});
