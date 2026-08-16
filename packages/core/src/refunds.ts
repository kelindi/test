import crypto from 'node:crypto';

import type { Actor } from './authz';
import type { DatabaseClient } from './db';

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
  ) {}

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
