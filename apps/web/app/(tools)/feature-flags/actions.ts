'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { currentActor } from '@/lib/auth';
import { defineAction, toggleFlag } from '@internal/core';

const schema = z.object({
  id: z.string().min(1),
  enabled: z.enum(['true', 'false']),
});

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
    schema,
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
