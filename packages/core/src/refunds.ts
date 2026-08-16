import crypto from 'node:crypto';

import type pg from 'pg';

import type { Actor } from './authz';
import { can } from './authz';

export type PaymentProvider = {
  refundPayment(
    paymentId: string,
    amountMinor: bigint,
    idempotencyKey: string,
  ): Promise<{ providerRefundId: string }>;
};

export class FakeStripeProvider implements PaymentProvider {
  calls: string[] = [];
  private readonly completed = new Map<string, string>();
  shouldFail = false;
  shouldTimeout = false;

  async refundPayment(
    paymentId: string,
    amountMinor: bigint,
    idempotencyKey: string,
  ) {
    const existing = this.completed.get(idempotencyKey);
    if (existing) return { providerRefundId: existing };
    this.calls.push(idempotencyKey);
    if (this.shouldTimeout)
      await new Promise((resolve) => setTimeout(resolve, 25));
    if (this.shouldFail) throw new Error('Mock provider failure');
    const providerRefundId = `re_${paymentId}_${amountMinor}`;
    this.completed.set(idempotencyKey, providerRefundId);
    return { providerRefundId };
  }
}

export async function dispatchRefund(
  client: pg.PoolClient,
  provider: PaymentProvider,
  actor: Actor,
  outboxId: number,
) {
  const item = (
    await client.query('SELECT * FROM outbox WHERE id = $1 FOR UPDATE', [
      outboxId,
    ])
  ).rows[0];
  if (!item || item.status === 'succeeded') return;

  const payload = item.payload as {
    refundId: string;
    paymentId: string;
    amountMinor: string;
    idempotencyKey: string;
  };

  try {
    await client.query(
      "UPDATE refund_requests SET state = 'executing' WHERE id = $1",
      [payload.refundId],
    );
    await provider.refundPayment(
      payload.paymentId,
      BigInt(payload.amountMinor),
      payload.idempotencyKey,
    );
    await client.query(
      `INSERT INTO ledger (refund_id, payment_id, amount_minor, currency)
       SELECT id, payment_id, amount_minor, currency FROM refund_requests WHERE id = $1
       ON CONFLICT (refund_id) DO NOTHING`,
      [payload.refundId],
    );
    await client.query(
      'UPDATE payments p SET refunded_minor = p.refunded_minor + r.amount_minor FROM refund_requests r WHERE r.id = $1 AND p.id = r.payment_id',
      [payload.refundId],
    );
    await client.query(
      "UPDATE refund_requests SET state = 'succeeded' WHERE id = $1",
      [payload.refundId],
    );
    await client.query("UPDATE outbox SET status = 'succeeded' WHERE id = $1", [
      outboxId,
    ]);
  } catch (error) {
    await client.query(
      "UPDATE refund_requests SET state = 'failed' WHERE id = $1",
      [payload.refundId],
    );
    await client.query(
      "UPDATE outbox SET status = 'pending', attempts = attempts + 1 WHERE id = $1",
      [outboxId],
    );
    throw error;
  }
}

export function newRefundIdempotencyKey(): string {
  return crypto.randomUUID();
}
