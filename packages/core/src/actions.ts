import { z, type ZodType } from 'zod';

import type { Action, Actor, RefundResource } from './authz';
import { can } from './authz';
import { withActor } from './db';

/**
 * All mutations pass through one pipeline so authentication, authorization,
 * validation, transaction context, and action auditing cannot drift by app.
 */
export async function defineAction<Input, Output>(
  actor: Actor | null,
  action: Action,
  resource: RefundResource,
  schema: ZodType<Input>,
  input: unknown,
  handler: (client: unknown, value: Input, traceId: string) => Promise<Output>,
): Promise<{ ok: true; data: Output } | { ok: false; error: string }> {
  if (!actor) return { ok: false, error: 'Authentication required' };
  if (!can(actor, action, resource))
    return { ok: false, error: 'Not authorized' };

  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.message };

  try {
    const data = await withActor(actor, async (client, traceId) => {
      const result = await handler(client, parsed.data, traceId);
      await client.query(
        "INSERT INTO application_audit_events(event_type, actor_id, request_id, metadata) VALUES ('action.invoked', $1, $2, $3)",
        [actor.id, traceId, JSON.stringify({ action })],
      );
      return result;
    });
    return { ok: true, data };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Action failed',
    };
  }
}

export const actionInput = z;
