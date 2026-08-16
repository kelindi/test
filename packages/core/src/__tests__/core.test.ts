import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  can,
  FakeStripeProvider,
  money,
  parseMoney,
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
    it('audits concurrent writes without forking the hash chain', async () => {
      await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          withActor(
            { ...support, id: `concurrent-${index}` },
            async (client) => {
              await client.query(
                'INSERT INTO customers (id, name, account_created_at) VALUES ($1, $2, now())',
                [`concurrent-${index}`, `Concurrent ${index}`],
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
              'SELECT id FROM refund_requests WHERE requester_id = $1',
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
          'SELECT ctid, row_hash FROM audit_log_default LIMIT 1',
        )
      ).rows[0];
      await client.query(
        'ALTER TABLE audit_log_default DISABLE TRIGGER audit_log_immutable',
      );
      await client.query(
        "UPDATE audit_log_default SET row_hash = 'tampered' WHERE ctid = $1",
        [original.ctid],
      );
      await client.query(
        'ALTER TABLE audit_log_default ENABLE TRIGGER audit_log_immutable',
      );
      await client.end();
      expect(await verifyAuditChain()).toBe(false);
      const restore = new owner.Client({
        connectionString: process.env.DATABASE_OWNER_URL,
      });
      await restore.connect();
      await restore.query(
        'UPDATE audit_log_default SET row_hash = $1 WHERE ctid = $2',
        [original.row_hash, original.ctid],
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
