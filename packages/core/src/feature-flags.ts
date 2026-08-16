/**
 * Feature flag management plane for the PoC.
 *
 * Product-facing flag reads are intentionally out of scope. When needed, products
 * should read flag state through a separate data plane (service-token endpoint,
 * SDK, or outbox-published edge store) that uses a distinct non-human actor and
 * RLS policy, because the current policies only admit internal human roles.
 */

import crypto from 'node:crypto';

import { can, type Actor } from './authz';
import { auditEvent, type DatabaseClient, logAccess, readAs } from './db';

export type FlagListRow = {
  id: string;
  key: string;
  description: string;
  environment: string;
  enabled: boolean;
  updatedBy: string;
  age: string;
};

export async function flagList(actor: Actor): Promise<FlagListRow[]> {
  if (!can(actor, 'flag:read')) throw new Error('Not authorized');
  return readAs(actor, async (client) => {
    const result = await client.query(
      `SELECT id, key, description, environment, enabled, updated_by,
              (now() - updated_at)::text AS age
       FROM feature_flags
       ORDER BY key, environment`,
    );
    return result.rows.map((row) => ({
      id: row.id,
      key: row.key,
      description: row.description,
      environment: row.environment,
      enabled: row.enabled,
      updatedBy: row.updated_by,
      age: row.age,
    }));
  });
}

export type FeatureFlag = {
  id: string;
  key: string;
  description: string;
  environment: string;
  enabled: boolean;
  updatedBy: string;
  updatedAt: Date;
};

export async function readFlag(
  actor: Actor,
  id: string,
  traceId: string = crypto.randomUUID(),
): Promise<FeatureFlag | null> {
  if (!can(actor, 'flag:read')) throw new Error('Not authorized');
  return readAs(actor, async (client) => {
    const row = (
      await client.query('SELECT * FROM feature_flags WHERE id = $1', [id])
    ).rows[0];
    if (!row) return null;
    await logAccess(client, actor, 'feature_flag', id, traceId);
    await auditEvent(
      client,
      'flag.read',
      actor,
      { flagId: id, key: row.key },
      traceId,
    );
    return {
      id: row.id,
      key: row.key,
      description: row.description,
      environment: row.environment,
      enabled: row.enabled,
      updatedBy: row.updated_by,
      updatedAt: new Date(row.updated_at),
    };
  });
}

export async function toggleFlag(
  client: DatabaseClient,
  actor: Actor,
  id: string,
  enabled: boolean,
  traceId: string,
): Promise<FeatureFlag> {
  if (!can(actor, 'flag:toggle')) throw new Error('Not authorized');
  const row = (
    await client.query('SELECT * FROM feature_flags WHERE id = $1', [id])
  ).rows[0];
  if (!row) throw new Error('Flag not found');

  const oldEnabled = Boolean(row.enabled);
  await client.query(
    `UPDATE feature_flags
     SET enabled = $1, updated_by = $2, updated_at = now()
     WHERE id = $3`,
    [enabled, actor.id, id],
  );

  await auditEvent(
    client,
    'flag.toggled',
    actor,
    {
      flagId: id,
      key: row.key,
      oldEnabled,
      newEnabled: enabled,
    },
    traceId,
  );

  return {
    id: row.id,
    key: row.key,
    description: row.description,
    environment: row.environment,
    enabled,
    updatedBy: actor.id,
    updatedAt: new Date(),
  };
}
