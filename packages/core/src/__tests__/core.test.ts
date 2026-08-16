import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  can,
  authenticateUser,
  claimNext,
  dispatchRefund,
  FakeStripeProvider,
  SYSTEM_ACTOR,
  sweepExecuting,
  money,
  parseMoney,
  refundableBalance,
  StateMachine,
  verifyAuditChain,
  withActor,
} from '..';

const support = { id: 'user_support', role: 'support_agent' as const };
const reviewerOne = { id: 'user_finance_1', role: 'finance_reviewer' as const };
const reviewerTwo = { id: 'user_finance_2', role: 'finance_reviewer' as const };

describe('authorization matrix', () => {
  it.each([
    ['support_agent', 'refund:create', true],
    ['support_agent', 'refund:approve', false],
    ['support_agent', 'refund:approvals:read', true],
    ['finance_reviewer', 'refund:create', false],
    ['finance_reviewer', 'refund:approve', true],
    ['admin', 'audit:export', true],
    ['admin', 'refund:approve', false],
  ])('%s %s -> %s', (role, action, expected) => {
    const actor = {
      id: role,
      role: role as 'support_agent' | 'finance_reviewer' | 'admin',
    };
    expect(
      can(actor, action as never, {
        state: 'pending_approval',
        requesterId: 'someone',
      }),
    ).toBe(expected);
  });
});

describe('state machine and money', () => {
  it('enforces distinct approvers', () => {
    const machine = new StateMachine([
      {
        from: 'pending',
        to: 'approved',
        action: 'approve',
        requiresDifferentActorFrom: 'requested',
      },
    ] as const);
    expect(() =>
      machine.transition('pending', 'approved', reviewerOne, 'approve', [
        { transition: 'requested', actorId: reviewerOne.id },
      ]),
    ).toThrow('Segregation');
    expect(
      machine.transition('pending', 'approved', reviewerTwo, 'approve', [
        { transition: 'requested', actorId: reviewerOne.id },
      ]),
    ).toBe('approved');
  });

  it('does exact minor-unit arithmetic and boundaries', () => {
    expect(parseMoney('10.99', 'USD').minor).toBe(1099n);
    expect(money(100n, 'USD').minor + parseMoney('1.00', 'USD').minor).toBe(
      200n,
    );
    expect(() => parseMoney('1.999', 'USD')).toThrow();
    expect(refundableBalance(1000n, 400n, 600n)).toBe(0n);
    expect(refundableBalance(1000n, 400n, 599n)).toBe(1n);
    expect(refundableBalance(1000n, 100n, 100n)).toBe(800n);
  });
});

describe('mechanical database guarantees', () => {
  it('does not allow app modules to import the raw client', () => {
    const appDir = path.join(process.cwd(), 'app');
    const source = fs
      .readdirSync(appDir, { recursive: true })
      .filter(
        (entry) =>
          String(entry).endsWith('.ts') || String(entry).endsWith('.tsx'),
      )
      .map((entry) => fs.readFileSync(path.join(appDir, String(entry)), 'utf8'))
      .join('\n');
    expect(source).not.toMatch(/from ['"]pg['"]/);
    expect(source).not.toMatch(/from ['"]@internal\/core\/.*db/);
  });
});

describe.runIf(Boolean(process.env.DATABASE_URL))(
  'Postgres compliance evidence',
  () => {
    it('authenticates every seeded account through the pre-auth primitive', async () => {
      const accounts = [
        ['support@example.com', 'support-password', 'support_agent'],
        ['finance1@example.com', 'finance-password', 'finance_reviewer'],
        ['finance2@example.com', 'finance-two-password', 'finance_reviewer'],
        ['admin@example.com', 'admin-password', 'admin'],
      ] as const;
      for (const [email, password, role] of accounts) {
        const user = await authenticateUser(email, password);
        expect(user?.role).toBe(role);
      }
      expect(
        await authenticateUser('support@example.com', 'wrong-password'),
      ).toBeNull();
    });

    it('preserves business justification while redacting customer PII', async () => {
      const rows = (
        await withActor(SYSTEM_ACTOR, (client) =>
          client.query(
            `SELECT table_name, column_name, sensitivity, redact_in_audit
             FROM sensitive_columns ORDER BY table_name, column_name`,
          ),
        )
      ).rows;
      expect(rows).toContainEqual({
        table_name: 'refund_requests',
        column_name: 'notes',
        sensitivity: 'internal',
        redact_in_audit: false,
      });
      expect(rows).toContainEqual({
        table_name: 'refund_approvals',
        column_name: 'comment',
        sensitivity: 'internal',
        redact_in_audit: false,
      });
      expect(rows).toContainEqual({
        table_name: 'customers',
        column_name: 'email',
        sensitivity: 'sensitive',
        redact_in_audit: true,
      });
    });

    it('executes an approved refund exactly once through outbox and ledger', async () => {
      const id = `refund-worker-${Date.now()}`;
      const key = `key-${id}`;
      await withActor(reviewerOne, async (client) => {
        await client.query(
          `INSERT INTO refund_requests
              (id, customer_id, payment_id, payment_snapshot, requested_by,
               amount_minor, currency, reason_code, notes, state, idempotency_key)
             VALUES ($1, 'customer_1', 'payment_1', $2, $3, 2, 'USD',
                     'customer_request', 'worker test', 'approved', $4)`,
          [
            id,
            JSON.stringify({ id: 'payment_1', amountMinor: '250000' }),
            support.id,
            key,
          ],
        );
        await client.query(
          `INSERT INTO outbox (kind, dedupe_key, payload)
             VALUES ('refund.execute', $1, $2)`,
          [
            id,
            JSON.stringify({
              refundId: id,
              paymentId: 'payment_1',
              amountMinor: '2',
              idempotencyKey: key,
            }),
          ],
        );
      });
      const provider = new FakeStripeProvider();
      await withActor(SYSTEM_ACTOR, async (client) => {
        const item = await claimNext(client);
        expect(item).not.toBeNull();
        await dispatchRefund(client, provider, SYSTEM_ACTOR, item!);
      });
      const result = await withActor(SYSTEM_ACTOR, async (client) => ({
        refund: (
          await client.query(
            'SELECT state FROM refund_requests WHERE id = $1',
            [id],
          )
        ).rows[0],
        ledger: (
          await client.query(
            'SELECT * FROM ledger_entries WHERE refund_request_id = $1',
            [id],
          )
        ).rows,
        calls: (
          await client.query(
            'SELECT * FROM provider_calls WHERE refund_request_id = $1',
            [id],
          )
        ).rows,
      }));
      expect(result.refund.state).toBe('succeeded');
      expect(result.ledger).toHaveLength(1);
      expect(result.calls).toHaveLength(1);
      expect(provider.calls).toEqual([key]);
    });

    it('settles a landed timeout through the sweeper without a duplicate ledger', async () => {
      const id = `refund-sweeper-${Date.now()}`;
      const key = `key-${id}`;
      await withActor(reviewerOne, async (client) => {
        await client.query(
          `INSERT INTO refund_requests
            (id, customer_id, payment_id, payment_snapshot, requested_by,
             amount_minor, currency, reason_code, notes, state, idempotency_key)
           VALUES ($1, 'customer_1', 'payment_1', $2, $3, 3, 'USD',
                   'customer_request', 'sweeper test', 'approved', $4)`,
          [
            id,
            JSON.stringify({ id: 'payment_1', amountMinor: '250000' }),
            support.id,
            key,
          ],
        );
        await client.query(
          `INSERT INTO outbox (kind, dedupe_key, payload)
           VALUES ('refund.execute', $1, $2)`,
          [
            id,
            JSON.stringify({
              refundId: id,
              paymentId: 'payment_1',
              amountMinor: '3',
              idempotencyKey: key,
            }),
          ],
        );
      });
      const provider = new FakeStripeProvider();
      provider.mode = 'timeout_then_succeeded';
      await withActor(SYSTEM_ACTOR, async (client) => {
        const item = await claimNext(client);
        await dispatchRefund(client, provider, SYSTEM_ACTOR, item!);
        await client.query(
          `UPDATE provider_calls SET created_at = now() - interval '3 minutes'
           WHERE refund_request_id = $1`,
          [id],
        );
        await sweepExecuting(client, provider);
      });
      const result = await withActor(SYSTEM_ACTOR, async (client) => ({
        state: (
          await client.query(
            'SELECT state FROM refund_requests WHERE id = $1',
            [id],
          )
        ).rows[0].state,
        ledger: (
          await client.query(
            'SELECT * FROM ledger_entries WHERE refund_request_id = $1',
            [id],
          )
        ).rows,
      }));
      expect(result.state).toBe('succeeded');
      expect(result.ledger).toHaveLength(1);
      expect(provider.calls).toEqual([key]);
    });

    it('audits concurrent writes without forking the hash chain', async () => {
      const suffix = Date.now().toString();
      await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          withActor(
            { ...support, id: `concurrent-${suffix}-${index}` },
            async (client) => {
              await client.query(
                `INSERT INTO customers
                  (id, external_id, name, email, account_created_at)
                 VALUES ($1, $2, $3, $4, now())`,
                [
                  `concurrent-${suffix}-${index}`,
                  `external-${suffix}-${index}`,
                  `Concurrent ${index}`,
                  `concurrent-${suffix}-${index}@example.com`,
                ],
              );
            },
          ),
        ),
      );
      expect(await verifyAuditChain()).toBe(true);
    });

    it('fails loudly without an actor', async () => {
      await expect(
        withActor(null as never, async () => undefined),
      ).rejects.toThrow('actor');
    });

    it('enforces RLS for a support actor at the database layer', async () => {
      const rows = await withActor(
        support,
        async (client) =>
          (
            await client.query(
              'SELECT id FROM refund_requests WHERE requested_by = $1',
              ['user_admin'],
            )
          ).rows,
      );
      expect(rows).toHaveLength(0);
    });

    it('detects a tampered audit row', async () => {
      const owner = (await import('pg')).default;
      const client = new owner.Client({
        connectionString: process.env.DATABASE_OWNER_URL,
      });
      await client.connect();
      const original = (
        await client.query(
          'SELECT id, created_at, row_hash, tableoid::regclass AS partition FROM audit_log LIMIT 1',
        )
      ).rows[0];
      expect(original).toBeDefined();
      await client.query(
        `ALTER TABLE ${original.partition} DISABLE TRIGGER ALL`,
      );
      await client.query(
        `UPDATE ${original.partition} SET row_hash = 'tampered' WHERE id = $1`,
        [original.id],
      );
      await client.query(
        `ALTER TABLE ${original.partition} ENABLE TRIGGER ALL`,
      );
      await client.end();
      expect(await verifyAuditChain()).toBe(false);
      const restore = new owner.Client({
        connectionString: process.env.DATABASE_OWNER_URL,
      });
      await restore.connect();
      await restore.query(
        `ALTER TABLE ${original.partition} DISABLE TRIGGER ALL`,
      );
      await restore.query(
        `UPDATE ${original.partition} SET row_hash = $1 WHERE id = $2`,
        [original.row_hash, original.id],
      );
      await restore.query(
        `ALTER TABLE ${original.partition} ENABLE TRIGGER ALL`,
      );
      await restore.end();
    });
  },
);

describe('provider idempotency seam', () => {
  it('records one provider call for one idempotency key', async () => {
    const provider = new FakeStripeProvider();
    await provider.refundPayment('payment_1', 100n, 'same-key');
    await provider.refundPayment('payment_1', 100n, 'same-key');
    expect(provider.calls).toEqual(['same-key']);
  });
});
