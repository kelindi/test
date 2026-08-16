'use server';

import crypto from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { auth } from '../../../auth';
import {
  auditEvent,
  can,
  defineAction,
  FakeStripeProvider,
  newRefundIdempotencyKey,
  parseMoney,
  refundableBalance,
  refundTransitions,
  SeededPaymentsClient,
  StateMachine,
  withActor,
} from '@internal/core';

const reasonCodes = [
  'duplicate',
  'fraud',
  'customer_request',
  'service_issue',
  'other',
] as const;

type Role = 'support_agent' | 'finance_reviewer' | 'admin';

async function currentActor() {
  const session = await auth();
  if (!session?.user) return null;
  return { id: session.user.id, role: session.user.role as Role };
}

export async function createRefund(formData: FormData) {
  const actor = await currentActor();
  const idempotencyKey = String(
    formData.get('idempotencyKey') || newRefundIdempotencyKey(),
  );
  const result = await defineAction(
    actor,
    'refund:create',
    {},
    z.object({
      amount: z.string(),
      reasonCode: z.enum(reasonCodes),
      notes: z.string().min(1).max(1000),
    }),
    {
      amount: String(formData.get('amount')),
      reasonCode: String(formData.get('reasonCode')),
      notes: String(formData.get('notes') ?? ''),
    },
    async (client, input, traceId) => {
      const amount = parseMoney(input.amount, 'USD');
      const payments = new SeededPaymentsClient(
        client,
        new FakeStripeProvider(),
      );
      const payment = await payments.getPayment('payment_1');
      if (!payment) throw new Error('Payment not found');
      const inFlight = (
        await client.query(
          `SELECT COALESCE(sum(amount_minor), 0) AS amount
           FROM refund_requests
           WHERE payment_id = $1 AND state IN ('pending_approval', 'approved', 'executing')`,
          [payment.id],
        )
      ).rows[0].amount;
      if (
        amount.minor >
        refundableBalance(
          payment.amountMinor,
          payment.refundedMinor,
          BigInt(inFlight),
        )
      ) {
        throw new Error('Amount exceeds remaining refundable balance');
      }
      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO refund_requests
          (id, customer_id, payment_id, payment_snapshot, requested_by, amount_minor,
           currency, reason_code, notes, state, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending_approval', $10)
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
          actor?.id,
          amount.minor.toString(),
          payment.currency,
          input.reasonCode,
          input.notes,
          idempotencyKey,
        ],
      );
      await auditEvent(
        client,
        'refund.created',
        actor!,
        { refundId: id },
        traceId,
      );
      const existing = (
        await client.query(
          'SELECT id FROM refund_requests WHERE idempotency_key = $1',
          [idempotencyKey],
        )
      ).rows[0];
      return existing.id as string;
    },
  );
  if (!result.ok) throw new Error(result.error);
  revalidatePath('/refunds');
}

async function transitionRefund(
  id: string,
  action: 'refund:approve' | 'refund:reject',
  comment: string | null,
) {
  const actor = await currentActor();
  if (!actor) throw new Error('Authentication required');
  await withActor(actor, async (client, traceId) => {
    const refund = (
      await client.query(
        'SELECT * FROM refund_requests WHERE id = $1 FOR UPDATE',
        [id],
      )
    ).rows[0];
    if (!refund) throw new Error('Refund not found');
    const approvals = (
      await client.query(
        `SELECT approver_id FROM refund_approvals
       WHERE refund_request_id = $1 AND decision = 'approved'`,
        [id],
      )
    ).rows.map((row) => row.approver_id);
    if (
      !can(actor, action, {
        state: refund.state,
        requesterId: refund.requested_by,
        approvalActorIds: approvals,
      })
    ) {
      throw new Error('Not authorized');
    }
    const machine = new StateMachine(refundTransitions);
    const next = action === 'refund:reject' ? 'rejected' : 'approved';
    machine.transition(
      refund.state,
      next,
      actor,
      action,
      [{ transition: 'refund:create', actorId: refund.requested_by }],
      {
        state: refund.state,
        requesterId: refund.requested_by,
        approvalActorIds: approvals,
      },
    );
    await client.query(
      `INSERT INTO refund_approvals
        (refund_request_id, approver_id, decision, reason_code, comment)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        id,
        actor.id,
        action === 'refund:approve' ? 'approved' : 'rejected',
        refund.reason_code,
        comment,
      ],
    );
    if (action === 'refund:reject') {
      await client.query(
        "UPDATE refund_requests SET state = 'rejected', updated_at = now() WHERE id = $1",
        [id],
      );
    } else {
      const threshold = BigInt(
        process.env.REFUND_APPROVAL_THRESHOLD_MINOR ?? '100000',
      );
      const count = approvals.length + 1;
      if (BigInt(refund.amount_minor) < threshold || count >= 2) {
        await client.query(
          "UPDATE refund_requests SET state = 'approved', updated_at = now() WHERE id = $1",
          [id],
        );
        await client.query(
          `INSERT INTO outbox (kind, dedupe_key, payload)
           VALUES ('refund.execute', $1, $2) ON CONFLICT (dedupe_key) DO NOTHING`,
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
      }
    }
    await auditEvent(
      client,
      'refund.transitioned',
      actor,
      { refundId: id, action, next },
      traceId,
    );
  });
  revalidatePath(`/refunds/${id}`);
  revalidatePath('/refunds');
}

export async function approveRefund(formData: FormData) {
  await transitionRefund(
    String(formData.get('id')),
    'refund:approve',
    String(formData.get('comment') || '') || null,
  );
}

export async function rejectRefund(formData: FormData) {
  await transitionRefund(
    String(formData.get('id')),
    'refund:reject',
    String(formData.get('comment') || '') || null,
  );
}
