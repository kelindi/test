'use server';

import crypto from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { currentActor } from '@/lib/auth';
import {
  auditEvent,
  can,
  createKycCase,
  decideKycCase,
  defineAction,
  logAccess,
  readAs,
  withActor,
} from '@internal/core';

const riskLevels = ['low', 'medium', 'high'] as const;

export async function searchCustomer(email: string) {
  const actor = await currentActor();
  if (!actor || !can(actor, 'customer:search')) {
    throw new Error('Not authorized');
  }
  return readAs(actor, async (client) => {
    const traceId = crypto.randomUUID();
    const customer = (
      await client.query(
        `SELECT id, external_id, name, email, account_created_at
         FROM customers WHERE lower(email) = lower($1)`,
        [email.trim()],
      )
    ).rows[0];
    if (customer) {
      await logAccess(client, actor, 'customer', customer.id, traceId);
    }
    return customer
      ? {
          id: customer.id,
          externalId: customer.external_id,
          name: customer.name,
          email: customer.email,
          accountCreatedAt: customer.account_created_at,
        }
      : null;
  });
}

export async function createKyc(formData: FormData) {
  const actor = await currentActor();
  const idempotencyKey = String(
    formData.get('idempotencyKey') || crypto.randomUUID(),
  );
  const result = await defineAction(
    actor,
    'kyc:create',
    {},
    z
      .object({
        customerId: z.string().min(1),
        riskLevel: z.enum(riskLevels),
        notes: z.string().max(1000),
        idempotencyKey: z.string().min(1),
      })
      .refine(
        (input) => input.riskLevel !== 'high' || input.notes.trim().length > 0,
        {
          message: 'Notes are required for high-risk cases',
          path: ['notes'],
        },
      ),
    {
      customerId: String(formData.get('customerId')),
      riskLevel: String(formData.get('riskLevel')),
      notes: String(formData.get('notes') ?? ''),
      idempotencyKey,
    },
    async (client, input, traceId) => {
      const id = await createKycCase(client, {
        customerId: input.customerId,
        submittedBy: actor!.id,
        riskLevel: input.riskLevel,
        notes: input.notes,
        idempotencyKey: input.idempotencyKey,
      });
      await auditEvent(
        client,
        'kyc.created',
        actor!,
        { kycCaseId: id },
        traceId,
      );
      return id;
    },
  );
  if (!result.ok) throw new Error(result.error);
  revalidatePath('/kyc');
  redirect('/kyc');
}

async function transitionKyc(
  id: string,
  action: 'kyc:approve' | 'kyc:reject' | 'kyc:request_info' | 'kyc:submit',
  comment: string | null,
) {
  const actor = await currentActor();
  if (!actor) throw new Error('Authentication required');
  await withActor(actor, async (client, traceId) => {
    await decideKycCase(client, actor, id, action, comment, traceId);
  });
  revalidatePath(`/kyc/${id}`);
  revalidatePath('/kyc');
}

export async function approveKyc(formData: FormData) {
  await transitionKyc(
    String(formData.get('id')),
    'kyc:approve',
    String(formData.get('comment') || '') || null,
  );
}

export async function rejectKyc(formData: FormData) {
  await transitionKyc(
    String(formData.get('id')),
    'kyc:reject',
    String(formData.get('comment') || '') || null,
  );
}

export async function requestInfoKyc(formData: FormData) {
  await transitionKyc(
    String(formData.get('id')),
    'kyc:request_info',
    String(formData.get('comment') || '') || null,
  );
}

export async function submitKyc(formData: FormData) {
  await transitionKyc(
    String(formData.get('id')),
    'kyc:submit',
    String(formData.get('comment') || '') || null,
  );
}
