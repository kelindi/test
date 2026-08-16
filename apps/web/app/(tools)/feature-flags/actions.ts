'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { currentActor } from '@/lib/auth';
import { createFlag, defineAction, toggleFlag } from '@internal/core';

const toggleSchema = z.object({
  id: z.string().min(1),
  enabled: z.enum(['true', 'false']),
});

const createSchema = z.object({
  key: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  environment: z.string().min(1).max(50),
  initialEnabled: z.enum(['true', 'false']).default('false'),
});

export async function createFlagAction(formData: FormData) {
  const actor = await currentActor();
  const input = {
    key: String(formData.get('key')),
    description: String(formData.get('description')),
    environment: String(formData.get('environment')),
    initialEnabled: String(formData.get('initialEnabled') ?? 'false'),
  };

  const result = await defineAction(
    actor,
    'flag:create',
    {},
    createSchema,
    input,
    async (client, value, traceId) => {
      return createFlag(
        client,
        actor!,
        {
          key: value.key,
          description: value.description,
          environment: value.environment,
          initialEnabled: value.initialEnabled === 'true',
        },
        traceId,
      );
    },
  );

  if (!result.ok) throw new Error(result.error);
  revalidatePath('/feature-flags');
  redirect('/feature-flags');
}

export async function toggleFlagAction(formData: FormData) {
  const actor = await currentActor();
  const input = {
    id: String(formData.get('id')),
    enabled: String(formData.get('enabled')),
  };

  const result = await defineAction(
    actor,
    'flag:toggle',
    {},
    toggleSchema,
    input,
    async (client, value, traceId) => {
      await toggleFlag(
        client,
        actor!,
        value.id,
        value.enabled === 'true',
        traceId,
      );
    },
  );

  if (!result.ok) throw new Error(result.error);
  revalidatePath('/feature-flags');
  revalidatePath(`/feature-flags/${input.id}`);
}
