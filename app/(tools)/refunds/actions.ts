'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import crypto from 'node:crypto';

import { auth } from '../../../auth';
import {
  can,
  defineAction,
  newRefundIdempotencyKey,
  parseMoney,
  withActor,
} from '@internal/core';

const reasonCodes = [
  'duplicate',
  'fraud',
  'customer_request',
  'service_issue',
] as const;

export async function createRefund(formData: FormData) {
  const session = await auth();
  const actor = session?.user
    ? { id: session.user.id, role: session.user.role as 'support_agent' }
    : null;
  const result = await defineAction(
    actor,
    'refund:create',
    {},
    z.object({
      amount: z.string(),
      reasonCode: z.enum(reasonCodes),
      notes: z.string().max(1000),
    }),
    {
      amount: String(formData.get('amount')),
      reasonCode: String(formData.get('reasonCode')),
      notes: String(formData.get('notes') ?? ''),
    },
    async (
      client: any,
      input: {
        amount: string;
        reasonCode: (typeof reasonCodes)[number];
        notes: string;
      },
    ) => {
      const parsed = parseMoney(input.amount, 'USD');
      const payment = (
        await client.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [
          'payment_1',
        ])
      ).rows[0];
      if (
        !payment ||
        parsed.minor >
          BigInt(payment.amount_minor) - BigInt(payment.refunded_minor)
      ) {
        throw new Error('Amount exceeds remaining refundable balance');
      }
      const idempotencyKey = String(
        formData.get('idempotencyKey') || newRefundIdempotencyKey(),
      );
      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO refund_requests
          (id, customer_id, payment_id, requester_id, amount_minor, currency, reason_code, notes, state, idempotency_key)
         VALUES ($1, 'customer_1', 'payment_1', $2, $3, 'USD', $4, $5, 'pending_approval', $6)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          id,
          actor?.id,
          parsed.minor.toString(),
          input.reasonCode,
          input.notes,
          idempotencyKey,
        ],
      );
      return id;
    },
  );
  if (!result.ok) throw new Error(result.error);
  revalidatePath('/refunds');
}

async function transitionRefund(
  id: string,
  action: 'refund:approve' | 'refund:reject',
) {
  const session = await auth();
  if (!session?.user) throw new Error('Authentication required');
  const actor = {
    id: session.user.id,
    role: session.user.role as 'finance_reviewer',
  };
  await withActor(actor, async (client) => {
    const refund = (
      await client.query(
        'SELECT * FROM refund_requests WHERE id = $1 FOR UPDATE',
        [id],
      )
    ).rows[0];
    if (!refund || !can(actor, action, refund))
      throw new Error('Not authorized');
    const approvals = [...(refund.approvals ?? []), actor.id];
    const threshold = BigInt(
      process.env.REFUND_APPROVAL_THRESHOLD_MINOR ?? '100000',
    );
    const needsSecond = BigInt(refund.amount_minor) >= threshold;
    if (action === 'refund:reject') {
      await client.query(
        "UPDATE refund_requests SET state = 'rejected' WHERE id = $1",
        [id],
      );
      return;
    }
    if (!needsSecond || approvals.length >= 2) {
      await client.query(
        "UPDATE refund_requests SET state = 'approved', approvals = $1 WHERE id = $2",
        [JSON.stringify(approvals), id],
      );
      await client.query(
        `INSERT INTO outbox (kind, dedupe_key, payload)
         VALUES ('refund.execute', $1, $2)
         ON CONFLICT (dedupe_key) DO NOTHING`,
        [
          `refund:${id}`,
          JSON.stringify({
            refundId: id,
            paymentId: refund.payment_id,
            amountMinor: refund.amount_minor.toString(),
            idempotencyKey: refund.idempotency_key,
          }),
        ],
      );
    } else {
      await client.query(
        'UPDATE refund_requests SET approvals = $1 WHERE id = $2',
        [JSON.stringify(approvals), id],
      );
    }
  });
  revalidatePath(`/refunds/${id}`);
  revalidatePath('/refunds');
}

export async function approveRefund(formData: FormData) {
  await transitionRefund(String(formData.get('id')), 'refund:approve');
}

export async function rejectRefund(formData: FormData) {
  await transitionRefund(String(formData.get('id')), 'refund:reject');
}
