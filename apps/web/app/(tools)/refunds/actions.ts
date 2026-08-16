'use server';

import crypto from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { currentActor } from '@/lib/auth';
import {
  auditEvent,
  approveRefundRequest,
  can,
  createRefundRequest,
  defineAction,
  enqueueOutbox,
  FakeStripeProvider,
  logAccess,
  lookupCustomerByEmail,
  newRefundIdempotencyKey,
  parseMoney,
  readAs,
  refundableBalance,
  SeededPaymentsClient,
  withActor,
} from '@internal/core';

const reasonCodes = [
  'duplicate',
  'fraud',
  'customer_request',
  'service_issue',
  'other',
] as const;

export async function searchCustomer(email: string) {
  const actor = await currentActor();
  if (!actor || !can(actor, 'customer:search')) {
    throw new Error('Not authorized');
  }
  return readAs(actor, async (client) => {
    const traceId = crypto.randomUUID();
    const payments = new SeededPaymentsClient(client, new FakeStripeProvider());
    return lookupCustomerByEmail(client, actor, payments, email, traceId);
  });
}

export async function listCustomerPayments(customerId: string) {
  const actor = await currentActor();
  if (!actor || !can(actor, 'customer:search')) {
    throw new Error('Not authorized');
  }
  return readAs(actor, async (client) => {
    const traceId = crypto.randomUUID();
    const payments = new SeededPaymentsClient(client, new FakeStripeProvider());
    const result = await payments.listCustomerPayments(customerId);
    const inFlightRows = (
      await client.query(
        `SELECT payment_id, COALESCE(sum(amount_minor), 0) AS amount
         FROM refund_requests
         WHERE payment_id = ANY($1::text[])
           AND state IN ('pending_approval', 'approved', 'executing')
         GROUP BY payment_id`,
        [result.map((payment) => payment.id)],
      )
    ).rows;
    const inFlight = new Map(
      inFlightRows.map((row) => [row.payment_id, BigInt(row.amount)]),
    );
    await logAccess(client, actor, 'customer', customerId, traceId);
    return result.map((payment) => ({
      ...payment,
      remainingMinor: refundableBalance(
        payment.amountMinor,
        payment.refundedMinor,
        inFlight.get(payment.id) ?? 0n,
      ),
    }));
  });
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
    z
      .object({
        customerId: z.string().min(1),
        paymentId: z.string().min(1),
        amount: z.string().optional(),
        reasonCode: z.enum(reasonCodes),
        notes: z.string().max(1000),
        source: z.enum(['manual', 'ticket', 'api']).default('manual'),
        externalReference: z.string().max(500).optional(),
      })
      .refine(
        (input) =>
          input.reasonCode !== 'other' || input.notes.trim().length > 0,
        { message: 'Notes are required when reason is other', path: ['notes'] },
      ),
    {
      customerId: String(formData.get('customerId')),
      paymentId: String(formData.get('paymentId')),
      amount: String(formData.get('amount') ?? ''),
      reasonCode: String(formData.get('reasonCode')),
      notes: String(formData.get('notes') ?? ''),
      source: String(formData.get('source') ?? 'manual'),
      externalReference:
        String(formData.get('externalReference') ?? '') || undefined,
    },
    async (client, input, traceId) => {
      const amount = input.amount?.trim()
        ? parseMoney(input.amount, 'USD')
        : null;
      const payments = new SeededPaymentsClient(
        client,
        new FakeStripeProvider(),
      );
      const id = await createRefundRequest(client, payments, {
        customerId: input.customerId,
        paymentId: input.paymentId,
        amountMinor: amount?.minor,
        currency: amount?.currency ?? 'USD',
        reasonCode: input.reasonCode,
        notes: input.notes,
        requestedBy: actor!.id,
        idempotencyKey,
        source: input.source,
        externalReference: input.externalReference,
      });
      await auditEvent(
        client,
        'refund.created',
        actor!,
        { refundId: id },
        traceId,
      );
      return id;
    },
  );
  if (!result.ok) {
    redirect(
      `/refunds/new?error=${encodeURIComponent(result.error ?? 'Request failed')}`,
    );
  }
  revalidatePath('/refunds');
  redirect('/refunds');
}

async function transitionRefund(
  id: string,
  action: 'refund:approve' | 'refund:reject',
  comment: string | null,
) {
  const actor = await currentActor();
  if (!actor) {
    redirect(
      `/refunds/${id}?error=${encodeURIComponent('Authentication required')}`,
    );
  }
  try {
    await withActor(actor, async (client, traceId) => {
      await approveRefundRequest(client, actor, id, action, comment, traceId);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Action failed';
    redirect(`/refunds/${id}?error=${encodeURIComponent(message)}`);
  }
  revalidatePath(`/refunds/${id}`);
  revalidatePath('/refunds');
  redirect(`/refunds/${id}`);
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
