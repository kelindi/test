import crypto from 'node:crypto';
import { z, type ZodType } from 'zod';

import type { Action, Actor, RefundResource } from './authz';
import { can } from './authz';
import { auditEvent, type DatabaseClient, withActor } from './db';

/**
 * The action wrapper is the sole mutation pipeline and exposes the typed
 * database client type from core, not an untyped escape hatch to applications.
 */
export async function defineAction<Input, Output>(
  actor: Actor | null,
  action: Action,
  resource: RefundResource,
  schema: ZodType<Input>,
  input: unknown,
  handler: (
    client: DatabaseClient,
    value: Input,
    traceId: string,
  ) => Promise<Output>,
): Promise<{ ok: true; data: Output } | { ok: false; error: string }> {
  const traceId: string = crypto.randomUUID();
  if (!actor) return { ok: false, error: 'Authentication required' };

  if (!can(actor, action, resource)) {
    await withActor(
      actor,
      async (client) => {
        await auditEvent(
          client,
          'authorization.denied',
          actor,
          { action },
          traceId,
        );
      },
      traceId,
    );
    return { ok: false, error: 'Not authorized' };
  }

  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    await withActor(
      actor,
      async (client) => {
        await auditEvent(
          client,
          'action.validation_failed',
          actor,
          { action },
          traceId,
        );
      },
      traceId,
    );
    return { ok: false, error: parsed.error.message };
  }

  try {
    const data = await withActor(
      actor,
      async (client, transactionTraceId) => {
        const result = await handler(client, parsed.data, transactionTraceId);
        await auditEvent(
          client,
          'action.invoked',
          actor,
          { action },
          transactionTraceId,
        );
        return result;
      },
      traceId,
    );
    return { ok: true, data };
  } catch (error) {
    await withActor(
      actor,
      async (client) => {
        await auditEvent(
          client,
          'action.failed',
          actor,
          { action, error: error instanceof Error ? error.message : 'unknown' },
          traceId,
        );
      },
      traceId,
    ).catch(() => undefined);
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Action failed',
    };
  }
}

export const actionInput = z;
