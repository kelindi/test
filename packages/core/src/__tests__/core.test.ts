import { describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  auditCsv,
  auditEvent,
  can,
  capabilityMatrix,
  authenticateUser,
  approveRefundRequest,
  claimNext,
  createFlag,
  createRefundRequest,
  dispatchRefund,
  FakeStripeProvider,
  enqueueOutbox,
  flagList,
  lookupCustomerByEmail,
  readFlag,
  SeededPaymentsClient,
  SYSTEM_ACTOR,
  sweepExecuting,
  money,
  parseMoney,
  queryAudit,
  refundableBalance,
  reviewerQueue,
  StateMachine,
  toggleFlag,
  verifyAuditChain,
  verifyApplicationAuditChain,
  withActor,
} from '..';
import { log } from '../logger';

const support = { id: 'user_support', role: 'support_agent' as const };
const reviewerOne = { id: 'user_finance_1', role: 'finance_reviewer' as const };
const reviewerTwo = { id: 'user_finance_2', role: 'finance_reviewer' as const };

describe('authorization matrix', () => {
  const roles = ['support_agent', 'finance_reviewer', 'admin'] as const;
  const actions = [
    'customer:search',
    'refund:create',
    'refund:read',
    'refund:approvals:read',
    'refund:approve',
    'refund:reject',
    'refund:retry',
    'refund:cancel',
    'refund:abandon',
    'audit:read',
    'audit:export',
  ] as const;
  const states = ['pending_approval', 'failed'] as const;

  it('states the authorization decision for every role, action, and state', () => {
    for (const role of roles) {
      for (const action of actions) {
        for (const state of states) {
          const actor = {
            id: role,
            role,
          };
          const expected =
            action === 'customer:search' ||
            action === 'refund:read' ||
            action === 'refund:approvals:read'
              ? true
              : role === 'support_agent'
                ? action === 'refund:create' ||
                  (action === 'refund:cancel' && state === 'pending_approval')
                : role === 'finance_reviewer'
                  ? action === 'refund:approve' || action === 'refund:reject'
                    ? state === 'pending_approval'
                    : action === 'refund:retry' && state === 'failed'
                  : action === 'audit:read' ||
                    action === 'audit:export' ||
                    (action === 'refund:retry' && state === 'failed') ||
                    (action === 'refund:abandon' && state === 'failed');
          expect(
            can(actor, action, {
              state,
              requesterId:
                role === 'support_agent' && action === 'refund:cancel'
                  ? role
                  : 'someone',
              approvalActorIds:
                role === 'finance_reviewer' && action === 'audit:read'
                  ? []
                  : undefined,
            }),
          ).toBe(expected);
        }
      }
    }
  });

  it('generates a capability entry for every action in the policy union', () => {
    const covered = new Set(capabilityMatrix().map((entry) => entry.action));
    for (const action of actions) expect(covered.has(action)).toBe(true);
    expect(
      capabilityMatrix().find(
        (entry) =>
          entry.role === 'finance_reviewer' && entry.action === 'audit:read',
      ),
    ).toEqual({
      role: 'finance_reviewer',
      action: 'audit:read',
      condition: 'own_decision',
    });
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

  it('round-trips JSONB audit fields in CSV without object stringification', () => {
    const csv = auditCsv([
      { id: 1, after_data: { reason: 'customer request', amount: 1250 } },
    ]);
    expect(csv).toContain(
      '"{""reason"":""customer request"",""amount"":1250}"',
    );
    const quotedJson = csv.split('\n')[1].match(/,"((?:""|[^"])*)"/)?.[1];
    expect(JSON.parse(quotedJson!.replaceAll('""', '"'))).toEqual({
      reason: 'customer request',
      amount: 1250,
    });
  });

  it('preserves structured logger field names while redacting values', () => {
    const output = vi
      .spyOn(console, 'info')
      .mockImplementation(() => undefined);
    log('test.event', {
      actorId: 'actor-1',
      email: 'secret@example.com',
      count: 2,
    });
    expect(JSON.parse(output.mock.calls[0][0] as string)).toMatchObject({
      event: 'test.event',
      actorId: 'actor-1',
      email: '[REDACTED]',
      count: 2,
    });
    output.mockRestore();
  });

  it('denies audit reads before any database query for unsupported roles', async () => {
    await expect(queryAudit(support)).rejects.toThrow('Not authorized');
  });
});

describe('mechanical database guarantees', () => {
  it('does not allow app modules to import the raw client', () => {
    const appDir = path.join(process.cwd(), 'apps/web/app');
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

    it('verifies application events with canonical multi-key metadata', async () => {
      await withActor(support, (client, traceId) =>
        auditEvent(
          client,
          'test.multi_key_metadata',
          support,
          { zulu: 'last', alpha: 'first' },
          traceId,
        ),
      );
      expect(await verifyApplicationAuditChain()).toBe(true);
    });

    it('preserves business justification while redacting customer PII', async () => {
      const rows = (
        await withActor(SYSTEM_ACTOR, (client) =>
          client.query(
            `SELECT table_name, column_name, redact_in_audit
             FROM sensitive_columns ORDER BY table_name, column_name`,
          ),
        )
      ).rows;
      expect(rows).toContainEqual({
        table_name: 'refund_requests',
        column_name: 'notes',
        redact_in_audit: false,
      });
      expect(rows).toContainEqual({
        table_name: 'refund_approvals',
        column_name: 'comment',
        redact_in_audit: false,
      });
      expect(rows).toContainEqual({
        table_name: 'customers',
        column_name: 'email',
        redact_in_audit: true,
      });
    });

    it('looks up the selected customer through PaymentsClient and access-logs the PII read', async () => {
      const customer = await withActor(support, async (client) => {
        const payments = new SeededPaymentsClient(
          client,
          new FakeStripeProvider(),
        );
        return lookupCustomerByEmail(
          client,
          support,
          payments,
          'second@example.com',
        );
      });
      expect(customer).toMatchObject({
        id: 'customer_2',
        externalId: 'cus_demo_2',
        email: 'second@example.com',
      });
      const access = await withActor(SYSTEM_ACTOR, (client) =>
        client.query(
          `SELECT resource_type, resource_id FROM access_log
           WHERE actor_id = $1 AND resource_type = 'customer'
           ORDER BY id DESC LIMIT 1`,
          [support.id],
        ),
      );
      expect(access.rows[0]).toEqual({
        resource_type: 'customer',
        resource_id: 'customer_2',
      });
    });

    it('creates a request from the looked-up customer and selected charge', async () => {
      const suffix = crypto.randomUUID();
      let expectedAmount = 0n;
      const refundId = await withActor(support, async (client) => {
        const payments = new SeededPaymentsClient(
          client,
          new FakeStripeProvider(),
        );
        const customer = await lookupCustomerByEmail(
          client,
          support,
          payments,
          'second@example.com',
        );
        expect(customer?.id).toBe('customer_2');
        const charges = await payments.listCustomerPayments(customer!.id);
        const charge = charges[0];
        expectedAmount = charge.amountMinor - charge.refundedMinor;
        return createRefundRequest(client, payments, {
          customerId: customer!.id,
          paymentId: charge.id,
          amountMinor: undefined,
          currency: charge.currency,
          reasonCode: 'customer_request',
          notes: null,
          requestedBy: support.id,
          idempotencyKey: `lookup-create-${suffix}`,
        });
      });
      const row = await withActor(support, (client) =>
        client.query(
          `SELECT customer_id, payment_id, amount_minor, requested_by
           FROM refund_requests WHERE id = $1`,
          [refundId],
        ),
      );
      expect(row.rows[0]).toMatchObject({
        customer_id: 'customer_2',
        requested_by: support.id,
      });
      expect(['payment_4', 'payment_5']).toContain(row.rows[0].payment_id);
      expect(BigInt(row.rows[0].amount_minor)).toBe(expectedAmount);
      await withActor(support, (client) =>
        client.query('DELETE FROM refund_requests WHERE id = $1', [refundId]),
      );
    });

    it('returns the database row id when refund submission is duplicated', async () => {
      const idempotencyKey = `duplicate-create-${crypto.randomUUID()}`;
      const input = {
        customerId: 'customer_2',
        paymentId: 'payment_4',
        amountMinor: 100n,
        currency: 'USD',
        reasonCode: 'customer_request',
        notes: null,
        requestedBy: support.id,
        idempotencyKey,
      } as const;
      const first = await withActor(support, (client) =>
        createRefundRequest(
          client,
          new SeededPaymentsClient(client, new FakeStripeProvider()),
          input,
        ),
      );
      const second = await withActor(support, (client) =>
        createRefundRequest(
          client,
          new SeededPaymentsClient(client, new FakeStripeProvider()),
          input,
        ),
      );
      expect(second).toBe(first);
      await withActor(support, (client) =>
        client.query('DELETE FROM refund_requests WHERE id = $1', [first]),
      );
    });

    it('projects the reviewer queue in one RLS-scoped data-layer query', async () => {
      const id = `queue-${crypto.randomUUID()}`;
      await withActor(support, (client) =>
        client.query(
          `INSERT INTO refund_requests
            (id, customer_id, payment_id, payment_snapshot, requested_by,
             amount_minor, currency, reason_code, notes, state, idempotency_key)
           VALUES ($1, 'customer_1', 'payment_1', '{}', $2, 100, 'USD',
                   'customer_request', NULL, 'pending_approval', $3)`,
          [id, support.id, `queue-key-${id}`],
        ),
      );
      const rows = await reviewerQueue(reviewerOne);
      expect(rows).toContainEqual(
        expect.objectContaining({
          id,
          customerId: 'customer_1',
          requestedAmountMinor: 100n,
          originalAmountMinor: 250000n,
          reasonCode: 'customer_request',
          requesterId: support.id,
          needsTwoApprovals: false,
          source: 'manual',
          externalReference: null,
        }),
      );
      await withActor(support, (client) =>
        client.query('DELETE FROM refund_requests WHERE id = $1', [id]),
      );
    });

    it('rejects mismatched customer and payment selections through the refund creation boundary', async () => {
      await expect(
        withActor(support, (client) =>
          createRefundRequest(
            client,
            new SeededPaymentsClient(client, new FakeStripeProvider()),
            {
              customerId: 'customer_2',
              paymentId: 'payment_1',
              amountMinor: 100n,
              currency: 'USD',
              reasonCode: 'customer_request',
              notes: 'Boundary test',
              requestedBy: support.id,
              idempotencyKey: `mismatch-${crypto.randomUUID()}`,
            },
          ),
        ),
      ).rejects.toThrow('does not belong');
    });

    it('evaluates payment invariants as the owner when the caller cannot see the counterpart row', async () => {
      await withActor(support, async (client) => {
        const visibility = await client.query(
          `SELECT id FROM payments
           WHERE set_config('app.current_actor_role', 'restricted', true) IS NOT NULL`,
        );
        expect(visibility.rows).toEqual([]);
        await client.query(
          `SELECT set_config('app.current_actor_role', 'support_agent', true)`,
        );
        const functionSecurity = await client.query(
          `SELECT p.prosecdef
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public'
             AND p.proname = 'validate_refund_payment'`,
        );
        expect(functionSecurity.rows[0].prosecdef).toBe(true);
      });
    });

    it('finance approval atomically settles state and enqueues execution work', async () => {
      const suffix = crypto.randomUUID();
      const refundId = await withActor(support, (client) =>
        createRefundRequest(
          client,
          new SeededPaymentsClient(client, new FakeStripeProvider()),
          {
            customerId: 'customer_1',
            paymentId: 'payment_2',
            amountMinor: 100n,
            currency: 'USD',
            reasonCode: 'other',
            notes: 'Approval action test',
            requestedBy: support.id,
            idempotencyKey: `approval-key-${suffix}`,
          },
        ),
      );
      await withActor(reviewerOne, async (client) => {
        await approveRefundRequest(
          client,
          reviewerOne,
          refundId,
          'refund:approve',
          'Approved',
        );
      });
      const result = await withActor(reviewerOne, (client) =>
        client.query('SELECT state FROM refund_requests WHERE id = $1', [
          refundId,
        ]),
      );
      expect(result.rows[0]).toEqual({ state: 'approved' });
      const outbox = await withActor(SYSTEM_ACTOR, (client) =>
        client.query('SELECT dedupe_key FROM outbox WHERE dedupe_key = $1', [
          `refund:${refundId}`,
        ]),
      );
      expect(outbox.rows[0]).toEqual({
        dedupe_key: `refund:${refundId}`,
      });
      await withActor(SYSTEM_ACTOR, (client) =>
        client.query('DELETE FROM outbox WHERE dedupe_key = $1', [
          `refund:${refundId}`,
        ]),
      );
      await withActor(SYSTEM_ACTOR, (client) =>
        client.query(
          'DELETE FROM refund_approvals WHERE refund_request_id = $1',
          [refundId],
        ),
      );
      await withActor(SYSTEM_ACTOR, (client) =>
        client.query('DELETE FROM refund_requests WHERE id = $1', [refundId]),
      );
    });

    it('requires two distinct finance reviewers for a high-value request', async () => {
      const suffix = crypto.randomUUID();
      const refundId = await withActor(support, (client) =>
        createRefundRequest(
          client,
          new SeededPaymentsClient(client, new FakeStripeProvider()),
          {
            customerId: 'customer_1',
            paymentId: 'payment_1',
            amountMinor: 150000n,
            currency: 'USD',
            reasonCode: 'customer_request',
            notes: null,
            requestedBy: support.id,
            idempotencyKey: `two-reviewers-${suffix}`,
          },
        ),
      );
      await withActor(reviewerOne, (client) =>
        approveRefundRequest(
          client,
          reviewerOne,
          refundId,
          'refund:approve',
          null,
        ),
      );
      const pending = await withActor(reviewerOne, (client) =>
        client.query('SELECT state FROM refund_requests WHERE id = $1', [
          refundId,
        ]),
      );
      expect(pending.rows[0]).toEqual({ state: 'pending_approval' });
      await expect(
        withActor(reviewerOne, (client) =>
          approveRefundRequest(
            client,
            reviewerOne,
            refundId,
            'refund:approve',
            null,
          ),
        ),
      ).rejects.toThrow(/segregation|already/i);
      await withActor(reviewerTwo, (client) =>
        approveRefundRequest(
          client,
          reviewerTwo,
          refundId,
          'refund:approve',
          null,
        ),
      );
      const approved = await withActor(reviewerTwo, (client) =>
        client.query('SELECT state FROM refund_requests WHERE id = $1', [
          refundId,
        ]),
      );
      expect(approved.rows[0]).toEqual({ state: 'approved' });
      await withActor(SYSTEM_ACTOR, async (client) => {
        await client.query('DELETE FROM outbox WHERE dedupe_key = $1', [
          `refund:${refundId}`,
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

    it('rejects self-approval, allows commentless rejection, and denies admin decisions', async () => {
      const suffix = crypto.randomUUID();
      const refundId = await withActor(support, (client) =>
        createRefundRequest(
          client,
          new SeededPaymentsClient(client, new FakeStripeProvider()),
          {
            customerId: 'customer_1',
            paymentId: 'payment_2',
            amountMinor: 100n,
            currency: 'USD',
            reasonCode: 'customer_request',
            notes: null,
            requestedBy: support.id,
            idempotencyKey: `decision-boundaries-${suffix}`,
          },
        ),
      );
      await expect(
        withActor(support, (client) =>
          approveRefundRequest(
            client,
            support,
            refundId,
            'refund:approve',
            null,
          ),
        ),
      ).rejects.toThrow(/segregation|not authorized/i);
      await expect(
        withActor(SYSTEM_ACTOR, (client) =>
          approveRefundRequest(
            client,
            SYSTEM_ACTOR,
            refundId,
            'refund:approve',
            null,
          ),
        ),
      ).rejects.toThrow(/not authorized|segregation/i);
      await expect(
        withActor(SYSTEM_ACTOR, (client) =>
          approveRefundRequest(
            client,
            SYSTEM_ACTOR,
            refundId,
            'refund:reject',
            null,
          ),
        ),
      ).rejects.toThrow(/not authorized|segregation/i);
      await withActor(reviewerOne, (client) =>
        approveRefundRequest(
          client,
          reviewerOne,
          refundId,
          'refund:reject',
          null,
        ),
      );
      const rejected = await withActor(reviewerOne, (client) =>
        client.query(`SELECT state FROM refund_requests WHERE id = $1`, [
          refundId,
        ]),
      );
      expect(rejected.rows[0]).toEqual({ state: 'rejected' });
      const approval = await withActor(SYSTEM_ACTOR, (client) =>
        client.query(
          `SELECT comment FROM refund_approvals
           WHERE refund_request_id = $1 AND decision = 'rejected'`,
          [refundId],
        ),
      );
      expect(approval.rows[0]).toEqual({ comment: null });
      await withActor(SYSTEM_ACTOR, async (client) => {
        await client.query(
          'DELETE FROM refund_approvals WHERE refund_request_id = $1',
          [refundId],
        );
        await client.query('DELETE FROM refund_requests WHERE id = $1', [
          refundId,
        ]);
      });
    });

    it('enqueues through the owner policy without changing the caller actor context', async () => {
      const dedupeKey = `actor-context-${crypto.randomUUID()}`;
      await withActor(reviewerOne, async (client) => {
        await enqueueOutbox(client, 'test.context', dedupeKey, {});
        const context = await client.query(
          `SELECT current_setting('app.current_actor_role') AS role,
                  current_setting('app.current_actor_id') AS actor_id`,
        );
        expect(context.rows[0]).toEqual({
          role: 'finance_reviewer',
          actor_id: reviewerOne.id,
        });
      });
      await withActor(SYSTEM_ACTOR, (client) =>
        client.query('DELETE FROM outbox WHERE dedupe_key = $1', [dedupeKey]),
      );
    });

    it('enforces the selected charge cap after external refunds and multiple in-flight partials', async () => {
      const suffix = crypto.randomUUID();
      const inFlightIds = [`in-flight-a-${suffix}`, `in-flight-b-${suffix}`];
      await withActor(support, async (client) => {
        for (const [index, id] of inFlightIds.entries()) {
          await client.query(
            `INSERT INTO refund_requests
              (id, customer_id, payment_id, payment_snapshot, requested_by,
               amount_minor, currency, reason_code, notes, state, idempotency_key)
             VALUES ($1, 'customer_1', 'payment_1', '{}', 'user_support',
                     50000, 'USD', 'other', 'In-flight test', 'pending_approval', $2)`,
            [id, `in-flight-key-${index}-${suffix}`],
          );
        }
      });
      await expect(
        withActor(support, (client) =>
          createRefundRequest(
            client,
            new SeededPaymentsClient(client, new FakeStripeProvider()),
            {
              customerId: 'customer_1',
              paymentId: 'payment_1',
              amountMinor: 100001n,
              currency: 'USD',
              reasonCode: 'customer_request',
              notes: 'Over cap',
              requestedBy: support.id,
              idempotencyKey: `over-cap-${suffix}`,
            },
          ),
        ),
      ).rejects.toThrow('remaining refundable balance');
      const created = await withActor(support, (client) =>
        createRefundRequest(
          client,
          new SeededPaymentsClient(client, new FakeStripeProvider()),
          {
            customerId: 'customer_1',
            paymentId: 'payment_1',
            amountMinor: undefined,
            currency: 'USD',
            reasonCode: 'customer_request',
            notes: 'At cap',
            requestedBy: support.id,
            idempotencyKey: `at-cap-${suffix}`,
          },
        ),
      );
      expect(created).toEqual(expect.any(String));
      const createdAmount = await withActor(support, (client) =>
        client.query('SELECT amount_minor FROM refund_requests WHERE id = $1', [
          created,
        ]),
      );
      expect(createdAmount.rows[0].amount_minor).toBe('100000');
      await withActor(support, (client) =>
        client.query(
          `DELETE FROM refund_requests
           WHERE id = ANY($1::text[]) OR idempotency_key = $2`,
          [inFlightIds, `at-cap-${suffix}`],
        ),
      );
    });

    it('database constraints reject cross-customer, currency, and over-amount refund writes', async () => {
      const cases = [
        {
          message: /foreign key|payment does not belong/i,
          values: ['raw-mismatch', 'customer_2', 'payment_1', 100, 'USD'] as [
            string,
            string,
            string,
            number,
            string,
          ],
        },
        {
          message: /currency must match/i,
          values: ['raw-currency', 'customer_1', 'payment_1', 100, 'EUR'] as [
            string,
            string,
            string,
            number,
            string,
          ],
        },
        {
          message: /amount exceeds/i,
          values: ['raw-amount', 'customer_1', 'payment_1', 250001, 'USD'] as [
            string,
            string,
            string,
            number,
            string,
          ],
        },
        {
          message: /check constraint|violates check/i,
          values: ['raw-notes', 'customer_1', 'payment_1', 100, 'USD'],
        },
      ];
      for (const [index, testCase] of cases.entries()) {
        await expect(
          withActor(support, (client) =>
            client.query(
              `INSERT INTO refund_requests
                (id, customer_id, payment_id, payment_snapshot, requested_by,
                 amount_minor, currency, reason_code, notes, state, idempotency_key)
               VALUES ($1, $2, $3, '{}', 'user_support', $4, $5,
                       $6, $7, 'pending_approval', $1)`,
              index === 3
                ? [...testCase.values, 'other', null]
                : [...testCase.values, 'other', 'raw constraint test'],
            ),
          ),
        ).rejects.toThrow(testCase.message);
      }
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
        await client.query(`SELECT enqueue_outbox('refund.execute', $1, $2)`, [
          id,
          JSON.stringify({
            refundId: id,
            paymentId: 'payment_1',
            amountMinor: '2',
            idempotencyKey: key,
          }),
        ]);
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
        await client.query(`SELECT enqueue_outbox('refund.execute', $1, $2)`, [
          id,
          JSON.stringify({
            refundId: id,
            paymentId: 'payment_1',
            amountMinor: '3',
            idempotencyKey: key,
          }),
        ]);
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

describe('feature flag authorization matrix', () => {
  const engineering = {
    id: 'user_engineering',
    role: 'engineering_team' as const,
  };

  it('grants engineering_team read, toggle, and create, denies other roles', () => {
    expect(can(engineering, 'flag:read')).toBe(true);
    expect(can(engineering, 'flag:toggle')).toBe(true);
    expect(can(engineering, 'flag:create')).toBe(true);
    expect(can(support, 'flag:read')).toBe(false);
    expect(can(support, 'flag:toggle')).toBe(false);
    expect(can(support, 'flag:create')).toBe(false);
    expect(can(reviewerOne, 'flag:read')).toBe(false);
    expect(can(reviewerOne, 'flag:toggle')).toBe(false);
    expect(can(reviewerOne, 'flag:create')).toBe(false);
  });

  it('grants admin flag read and create but not toggle', () => {
    expect(can({ id: 'user_admin', role: 'admin' }, 'flag:read')).toBe(true);
    expect(can({ id: 'user_admin', role: 'admin' }, 'flag:create')).toBe(true);
    expect(can({ id: 'user_admin', role: 'admin' }, 'flag:toggle')).toBe(false);
  });

  it('includes flag capabilities in the capability matrix', () => {
    const matrix = capabilityMatrix();
    expect(matrix).toEqual(
      expect.arrayContaining([
        { role: 'engineering_team', action: 'flag:read' },
        { role: 'engineering_team', action: 'flag:toggle' },
        { role: 'engineering_team', action: 'flag:create' },
        { role: 'admin', action: 'flag:read' },
        { role: 'admin', action: 'flag:create' },
      ]),
    );
  });
});

describe.runIf(Boolean(process.env.DATABASE_URL))(
  'Feature flag Postgres compliance evidence',
  () => {
    const engineering = {
      id: 'user_engineering',
      role: 'engineering_team' as const,
    };

    it('lists seeded flags for engineering_team and admin, hides them from support', async () => {
      const engineeringRows = await flagList(engineering);
      expect(engineeringRows.length).toBeGreaterThanOrEqual(2);
      const adminRows = await flagList({ id: 'user_admin', role: 'admin' });
      expect(adminRows.map((r) => r.key)).toEqual(
        expect.arrayContaining(engineeringRows.map((r) => r.key)),
      );
      await expect(flagList(support)).rejects.toThrow('Not authorized');
    });

    it('records an audit event when a flag is toggled', async () => {
      const flagId = `flag-toggle-${crypto.randomUUID()}`;
      await withActor(SYSTEM_ACTOR, async (client) => {
        await client.query(
          `INSERT INTO feature_flags (id, key, description, environment, enabled, updated_by)
           VALUES ($1, $2, 'Audit toggle flag', 'test', false, $3)`,
          [flagId, `audit-toggle-${crypto.randomUUID()}`, engineering.id],
        );
      });

      await withActor(engineering, (client, traceId) =>
        toggleFlag(client, engineering, flagId, true, traceId),
      );

      const row = await withActor(engineering, (client) =>
        client.query(
          'SELECT enabled, updated_by FROM feature_flags WHERE id = $1',
          [flagId],
        ),
      );
      expect(row.rows[0]).toEqual({
        enabled: true,
        updated_by: engineering.id,
      });

      const appEvents = await withActor(SYSTEM_ACTOR, (client) =>
        client.query(
          `SELECT metadata FROM application_audit_events
           WHERE event_type = 'flag.toggled' AND actor_id = $1
           ORDER BY id DESC LIMIT 1`,
          [engineering.id],
        ),
      );
      expect(appEvents.rows[0].metadata).toMatchObject({
        flagId,
        oldEnabled: false,
        newEnabled: true,
      });

      const auditRows = await withActor(SYSTEM_ACTOR, (client) =>
        client.query(
          `SELECT operation, before_data, after_data FROM audit_log
           WHERE table_name = 'feature_flags' AND row_pk = $1
           ORDER BY id DESC`,
          [flagId],
        ),
      );
      const update = auditRows.rows.find((r) => r.operation === 'UPDATE');
      expect(update).toBeDefined();
      expect(Boolean(update.before_data.enabled)).toBe(false);
      expect(Boolean(update.after_data.enabled)).toBe(true);

      await withActor(SYSTEM_ACTOR, (client) =>
        client.query('DELETE FROM feature_flags WHERE id = $1', [flagId]),
      );
    });

    it('creates a flag through the core boundary and audits it', async () => {
      const key = `create-test-${crypto.randomUUID()}`;
      const flagId = await withActor(engineering, (client, traceId) =>
        createFlag(
          client,
          engineering,
          {
            key,
            description: 'Create boundary test',
            environment: 'test',
            initialEnabled: true,
          },
          traceId,
        ),
      );

      const row = await withActor(engineering, (client) =>
        client.query('SELECT key, enabled FROM feature_flags WHERE id = $1', [
          flagId,
        ]),
      );
      expect(row.rows[0]).toEqual({ key, enabled: true });

      const appEvents = await withActor(SYSTEM_ACTOR, (client) =>
        client.query(
          `SELECT metadata FROM application_audit_events
           WHERE event_type = 'flag.created' AND actor_id = $1
           ORDER BY id DESC LIMIT 1`,
          [engineering.id],
        ),
      );
      expect(appEvents.rows[0].metadata).toMatchObject({ flagId, key });

      await withActor(SYSTEM_ACTOR, (client) =>
        client.query('DELETE FROM feature_flags WHERE id = $1', [flagId]),
      );
    });

    it('denies support actors visibility into feature_flags through RLS', async () => {
      const rows = await withActor(support, async (client) => ({
        flags: (await client.query('SELECT id FROM feature_flags')).rows,
      }));
      expect(rows.flags).toHaveLength(0);
    });
  },
);
