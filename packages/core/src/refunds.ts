import crypto from 'node:crypto';

import { can, type Actor } from './authz';
import {
  auditEvent,
  enqueueOutbox,
  logAccess,
  readAs,
  type DatabaseClient,
} from './db';
import { refundTransitions, StateMachine } from './state-machine';

export type PaymentSnapshot = {
  id: string;
  customerId: string;
  externalPaymentId: string;
  amountMinor: bigint;
  refundedMinor: bigint;
  currency: string;
  capturedAt: string;
  status: string;
};

export type CustomerSnapshot = {
  id: string;
  externalId: string;
  name: string;
  email: string;
};

export type ReviewerQueueRow = {
  id: string;
  customerId: string;
  customerName: string;
  customerEmail: string;
  requestedAmountMinor: bigint;
  originalAmountMinor: bigint;
  reasonCode: string;
  state: string;
  requesterId: string;
  age: string;
  approvalCount: number;
  needsTwoApprovals: boolean;
  source: 'manual' | 'ticket' | 'api';
  externalReference: string | null;
};

export async function reviewerQueue(actor: Actor): Promise<ReviewerQueueRow[]> {
  if (!can(actor, 'refund:read')) throw new Error('Not authorized');
  const threshold = BigInt(
    process.env.REFUND_APPROVAL_THRESHOLD_MINOR ?? '100000',
  );
  return readAs(actor, async (client) => {
    const result = await client.query(
      `SELECT r.id, r.customer_id, c.name AS customer_name, c.email AS customer_email,
              r.amount_minor AS requested_amount_minor,
              p.amount_minor AS original_amount_minor,
              r.reason_code, r.state, r.requested_by, (now() - r.created_at)::text AS age,
              COUNT(a.id)::int AS approval_count,
              (r.amount_minor >= $1) AS needs_two_approvals,
              r.source, r.external_reference
       FROM refund_requests r
       JOIN customers c ON c.id = r.customer_id
       JOIN payments p ON p.id = r.payment_id
       LEFT JOIN refund_approvals a
         ON a.refund_request_id = r.id AND a.decision = 'approved'
       GROUP BY r.id, c.name, c.email, p.amount_minor
       ORDER BY r.created_at ASC`,
      [threshold.toString()],
    );
    return result.rows.map((row) => ({
      id: row.id,
      customerId: row.customer_id,
      customerName: row.customer_name,
      customerEmail: row.customer_email,
      requestedAmountMinor: BigInt(row.requested_amount_minor),
      originalAmountMinor: BigInt(row.original_amount_minor),
      reasonCode: row.reason_code,
      state: row.state,
      requesterId: row.requested_by,
      age: row.age,
      approvalCount: row.approval_count,
      needsTwoApprovals: row.needs_two_approvals,
      source: row.source,
      externalReference: row.external_reference,
    }));
  });
}

export async function lookupCustomerByEmail(
  client: DatabaseClient,
  actor: Actor,
  payments: PaymentsClient,
  email: string,
  traceId: string = crypto.randomUUID(),
): Promise<CustomerSnapshot | null> {
  if (!can(actor, 'customer:search')) throw new Error('Not authorized');
  const customer = await payments.findCustomerByEmail(email.trim());
  await logAccess(
    client,
    actor,
    'customer',
    customer?.id ?? 'email_lookup_not_found',
    traceId,
  );
  return customer;
}

export function refundableBalance(
  externalAmountMinor: bigint,
  externalRefundedMinor: bigint,
  inFlightMinor: bigint,
): bigint {
  const remaining = externalAmountMinor - externalRefundedMinor - inFlightMinor;
  if (remaining < 0n) return 0n;
  return remaining;
}

export type ProviderRefund = {
  providerRefundId: string;
  status: 'succeeded';
};

export interface PaymentsClient {
  findCustomerByEmail(email: string): Promise<CustomerSnapshot | null>;
  listCustomerPayments(customerId: string): Promise<PaymentSnapshot[]>;
  getPayment(paymentId: string): Promise<PaymentSnapshot | null>;
  refundPayment(
    paymentId: string,
    amountMinor: bigint,
    idempotencyKey: string,
  ): Promise<ProviderRefund>;
  getRefund(idempotencyKey: string): Promise<ProviderRefund | null>;
}

export class ProviderTimeoutAfterAcceptance extends Error {
  constructor() {
    super('Mock provider timeout after acceptance');
    this.name = 'ProviderTimeoutAfterAcceptance';
  }
}

export class FakeStripeProvider implements PaymentsClient {
  readonly calls: string[] = [];
  mode: 'success' | 'hard_failure' | 'timeout_then_succeeded' = 'success';
  private readonly refunds = new Map<string, ProviderRefund>();
  private readonly customer: CustomerSnapshot;

  constructor(
    private readonly payment: PaymentSnapshot = {
      id: 'payment_1',
      customerId: 'customer_1',
      externalPaymentId: 'ch_demo_1',
      amountMinor: 250000n,
      refundedMinor: 0n,
      currency: 'USD',
      capturedAt: new Date(0).toISOString(),
      status: 'captured',
    },
    customer: CustomerSnapshot = {
      id: payment.customerId,
      externalId: 'cus_demo_1',
      name: 'Demo Customer',
      email: 'customer@example.com',
    },
  ) {
    this.customer = customer;
  }

  async findCustomerByEmail(email: string): Promise<CustomerSnapshot | null> {
    return email.toLowerCase() === this.customer.email.toLowerCase()
      ? this.customer
      : null;
  }

  async listCustomerPayments(customerId: string): Promise<PaymentSnapshot[]> {
    return customerId === this.payment.customerId ? [this.payment] : [];
  }

  async getPayment(paymentId: string): Promise<PaymentSnapshot | null> {
    return paymentId === this.payment.id ? this.payment : null;
  }

  async refundPayment(
    paymentId: string,
    amountMinor: bigint,
    idempotencyKey: string,
  ): Promise<ProviderRefund> {
    const existing = this.refunds.get(idempotencyKey);
    if (existing) return existing;
    this.calls.push(idempotencyKey);
    if (this.mode === 'hard_failure') throw new Error('Mock provider failure');
    const result = {
      providerRefundId: `re_${paymentId}_${amountMinor}`,
      status: 'succeeded' as const,
    };
    if (this.mode === 'timeout_then_succeeded') {
      this.refunds.set(idempotencyKey, result);
      throw new ProviderTimeoutAfterAcceptance();
    }
    this.refunds.set(idempotencyKey, result);
    return result;
  }

  async getRefund(idempotencyKey: string): Promise<ProviderRefund | null> {
    return this.refunds.get(idempotencyKey) ?? null;
  }
}

export class SeededPaymentsClient implements PaymentsClient {
  constructor(
    private readonly client: DatabaseClient,
    private readonly provider: PaymentsClient,
  ) {}

  async findCustomerByEmail(email: string): Promise<CustomerSnapshot | null> {
    const row = (
      await this.client.query(
        `SELECT id, external_id, name, email
         FROM customers WHERE lower(email) = lower($1)`,
        [email],
      )
    ).rows[0];
    if (!row) return null;
    return {
      id: row.id,
      externalId: row.external_id,
      name: row.name,
      email: row.email,
    };
  }

  async listCustomerPayments(customerId: string): Promise<PaymentSnapshot[]> {
    const rows = (
      await this.client.query(
        'SELECT * FROM payments WHERE customer_id = $1 ORDER BY captured_at DESC',
        [customerId],
      )
    ).rows;
    return rows.map((row) => ({
      id: row.id,
      customerId: row.customer_id,
      externalPaymentId: row.external_payment_id,
      amountMinor: BigInt(row.amount_minor),
      refundedMinor: BigInt(row.refunded_minor),
      currency: row.currency,
      capturedAt: new Date(row.captured_at).toISOString(),
      status: row.status,
    }));
  }

  async getPayment(paymentId: string): Promise<PaymentSnapshot | null> {
    const row = (
      await this.client.query('SELECT * FROM payments WHERE id = $1', [
        paymentId,
      ])
    ).rows[0];
    if (!row) return null;
    return {
      id: row.id,
      customerId: row.customer_id,
      externalPaymentId: row.external_payment_id,
      amountMinor: BigInt(row.amount_minor),
      refundedMinor: BigInt(row.refunded_minor),
      currency: row.currency,
      capturedAt: new Date(row.captured_at).toISOString(),
      status: row.status,
    };
  }

  refundPayment(
    paymentId: string,
    amountMinor: bigint,
    idempotencyKey: string,
  ) {
    return this.provider.refundPayment(paymentId, amountMinor, idempotencyKey);
  }

  getRefund(idempotencyKey: string) {
    return this.provider.getRefund(idempotencyKey);
  }
}

export type CreateRefundInput = {
  customerId: string;
  paymentId: string;
  amountMinor?: bigint;
  currency: string;
  reasonCode: string;
  notes: string | null;
  requestedBy: string;
  idempotencyKey: string;
  source?: 'manual' | 'ticket' | 'api';
  externalReference?: string | null;
};

export async function createRefundRequest(
  client: DatabaseClient,
  payments: PaymentsClient,
  input: CreateRefundInput,
): Promise<string> {
  const payment = await payments.getPayment(input.paymentId);
  if (!payment) throw new Error('Payment not found');
  if (payment.customerId !== input.customerId) {
    throw new Error('Payment does not belong to selected customer');
  }
  if (payment.currency !== input.currency) {
    throw new Error('Refund currency must match payment currency');
  }
  const inFlight = (
    await client.query(
      `SELECT COALESCE(sum(amount_minor), 0) AS amount
       FROM refund_requests
       WHERE payment_id = $1 AND state IN ('pending_approval', 'approved', 'executing')`,
      [payment.id],
    )
  ).rows[0].amount;
  const remaining = refundableBalance(
    payment.amountMinor,
    payment.refundedMinor,
    BigInt(inFlight),
  );
  const amountMinor = input.amountMinor ?? remaining;
  if (amountMinor <= 0n || amountMinor > remaining) {
    throw new Error('Amount exceeds remaining refundable balance');
  }
  const id = crypto.randomUUID();
  await client.query(
    `INSERT INTO refund_requests
      (id, customer_id, payment_id, payment_snapshot, requested_by, amount_minor,
       currency, reason_code, notes, state, source, external_reference, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending_approval', $10, $11, $12)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      id,
      payment.customerId,
      payment.id,
      JSON.stringify({
        ...payment,
        amountMinor: payment.amountMinor.toString(),
        refundedMinor: payment.refundedMinor.toString(),
      }),
      input.requestedBy,
      amountMinor.toString(),
      payment.currency,
      input.reasonCode,
      input.notes?.trim() || null,
      input.source ?? 'manual',
      input.externalReference ?? null,
      input.idempotencyKey,
    ],
  );
  const existing = (
    await client.query(
      'SELECT id FROM refund_requests WHERE idempotency_key = $1',
      [input.idempotencyKey],
    )
  ).rows[0];
  return existing.id as string;
}

export async function approveRefundRequest(
  client: DatabaseClient,
  actor: Actor,
  refundId: string,
  action: 'refund:approve' | 'refund:reject',
  comment: string | null,
  traceId: string = crypto.randomUUID(),
): Promise<string> {
  const refund = (
    await client.query(
      'SELECT * FROM refund_requests WHERE id = $1 FOR UPDATE',
      [refundId],
    )
  ).rows[0];
  if (!refund) throw new Error('Refund not found');
  const approvals = (
    await client.query(
      `SELECT approver_id FROM refund_approvals
       WHERE refund_request_id = $1 AND decision = 'approved'`,
      [refundId],
    )
  ).rows.map((row) => row.approver_id);
  const resource = {
    state: refund.state,
    requesterId: refund.requested_by,
    approvalActorIds: approvals,
  };
  const machine = new StateMachine(refundTransitions);
  const next = action === 'refund:reject' ? 'rejected' : 'approved';
  machine.transition(
    refund.state,
    next,
    actor,
    action,
    [{ transition: 'refund:create', actorId: refund.requested_by }],
    resource,
  );
  await client.query(
    `INSERT INTO refund_approvals
      (refund_request_id, approver_id, decision, reason_code, comment)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      refundId,
      actor.id,
      action === 'refund:approve' ? 'approved' : 'rejected',
      refund.reason_code,
      comment,
    ],
  );
  if (action === 'refund:reject') {
    await client.query(
      "UPDATE refund_requests SET state = 'rejected', updated_at = now() WHERE id = $1",
      [refundId],
    );
  } else {
    const threshold = BigInt(
      process.env.REFUND_APPROVAL_THRESHOLD_MINOR ?? '100000',
    );
    if (BigInt(refund.amount_minor) < threshold || approvals.length + 1 >= 2) {
      await client.query(
        "UPDATE refund_requests SET state = 'approved', updated_at = now() WHERE id = $1",
        [refundId],
      );
      await enqueueOutbox(client, 'refund.execute', `refund:${refundId}`, {
        refundId,
        paymentId: refund.payment_id,
        amountMinor: refund.amount_minor.toString(),
        idempotencyKey: refund.idempotency_key,
      });
    }
  }
  await auditEvent(
    client,
    'refund.transitioned',
    actor,
    { refundId, action, next },
    traceId,
  );
  return next;
}

export async function claimNext(client: DatabaseClient) {
  const result = await client.query(
    `SELECT * FROM outbox
     WHERE status = 'pending' AND next_attempt_at <= now()
     ORDER BY id
     FOR UPDATE SKIP LOCKED
     LIMIT 1`,
  );
  const item = result.rows[0];
  if (!item) return null;
  await client.query(
    "UPDATE outbox SET status = 'processing', attempts = attempts + 1 WHERE id = $1",
    [item.id],
  );
  return item;
}

export async function dispatchRefund(
  client: DatabaseClient,
  payments: PaymentsClient,
  actor: Actor,
  item: {
    id: number;
    payload: {
      refundId: string;
      paymentId: string;
      amountMinor: string;
      idempotencyKey: string;
    };
  },
): Promise<void> {
  const payload = item.payload;
  await client.query(
    "UPDATE refund_requests SET state = 'executing', updated_at = now() WHERE id = $1 AND state IN ('approved', 'failed')",
    [payload.refundId],
  );
  await client.query(
    `INSERT INTO provider_calls (refund_request_id, idempotency_key, request_payload, status)
     VALUES ($1, $2, $3, 'pending')
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [payload.refundId, payload.idempotencyKey, JSON.stringify(payload)],
  );
  try {
    const response = await payments.refundPayment(
      payload.paymentId,
      BigInt(payload.amountMinor),
      payload.idempotencyKey,
    );
    await client.query(
      `UPDATE provider_calls SET response_payload = $1, status = 'succeeded'
       WHERE idempotency_key = $2`,
      [JSON.stringify(response), payload.idempotencyKey],
    );
    await settleSucceeded(client, payload.refundId);
    await client.query("UPDATE outbox SET status = 'succeeded' WHERE id = $1", [
      item.id,
    ]);
  } catch (error) {
    if (error instanceof ProviderTimeoutAfterAcceptance) {
      await client.query(
        `UPDATE provider_calls SET status = 'unknown'
         WHERE idempotency_key = $1`,
        [payload.idempotencyKey],
      );
      await client.query(
        `UPDATE refund_requests SET state = 'executing', updated_at = now() WHERE id = $1`,
        [payload.refundId],
      );
      await client.query(
        `UPDATE outbox SET status = 'processing', last_error = $1 WHERE id = $2`,
        [error.message, item.id],
      );
    } else {
      await client.query(
        `UPDATE provider_calls SET response_payload = $1, status = 'failed'
         WHERE idempotency_key = $2`,
        [
          JSON.stringify({
            error: error instanceof Error ? error.message : 'unknown',
          }),
          payload.idempotencyKey,
        ],
      );
      await client.query(
        `UPDATE refund_requests SET state = 'failed', updated_at = now() WHERE id = $1`,
        [payload.refundId],
      );
      await client.query(
        `UPDATE outbox SET status = 'pending', last_error = $1, next_attempt_at = now() + interval '1 minute' WHERE id = $2`,
        [error instanceof Error ? error.message : 'unknown', item.id],
      );
    }
  }
}

export async function sweepExecuting(
  client: DatabaseClient,
  payments: PaymentsClient,
): Promise<void> {
  const stuck = (
    await client.query(
      `SELECT r.id, r.idempotency_key
       FROM refund_requests r
       JOIN provider_calls p ON p.refund_request_id = r.id
       WHERE r.state = 'executing'
         AND p.response_payload IS NULL
         AND p.created_at < now() - interval '2 minutes'
       FOR UPDATE OF r SKIP LOCKED`,
    )
  ).rows;
  for (const refund of stuck) {
    try {
      const found = await payments.getRefund(refund.idempotency_key);
      if (found) {
        await client.query(
          'UPDATE provider_calls SET response_payload = $1, status = $2 WHERE idempotency_key = $3',
          [JSON.stringify(found), 'succeeded', refund.idempotency_key],
        );
        await settleSucceeded(client, refund.id);
      } else {
        await client.query(
          `UPDATE refund_requests SET state = 'failed', updated_at = now() WHERE id = $1`,
          [refund.id],
        );
        await client.query(
          `UPDATE outbox SET status = 'pending', last_error = 'Provider refund not found',
             next_attempt_at = now() WHERE dedupe_key = $1`,
          [`refund:${refund.id}`],
        );
      }
    } catch {
      await client.query(
        `UPDATE outbox SET attempts = attempts + 1, last_error = 'Provider unreachable'
         WHERE dedupe_key = $1`,
        [`refund:${refund.id}`],
      );
    }
  }
}

export async function settleSucceeded(
  client: DatabaseClient,
  refundId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO ledger_entries (refund_request_id, payment_id, amount_minor, currency, direction)
     SELECT id, payment_id, amount_minor, currency, 'debit'
     FROM refund_requests WHERE id = $1 ON CONFLICT (refund_request_id) DO NOTHING`,
    [refundId],
  );
  await client.query(
    `UPDATE payments p SET refunded_minor = p.refunded_minor + r.amount_minor
     FROM refund_requests r WHERE r.id = $1 AND p.id = r.payment_id`,
    [refundId],
  );
  await client.query(
    "UPDATE refund_requests SET state = 'succeeded', updated_at = now() WHERE id = $1",
    [refundId],
  );
}

export function newRefundIdempotencyKey(): string {
  return crypto.randomUUID();
}
