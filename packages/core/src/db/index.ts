import 'dotenv/config';

import crypto from 'node:crypto';
import pg from 'pg';

import type { Actor } from '../authz';
import { SYSTEM_ACTOR, type Role } from '../authz';

export type DatabaseClient = pg.PoolClient;

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});

export type AuthenticatedUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
};

function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, expected] = storedHash.split(':');
  if (!salt || !expected) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expectedBuffer = Buffer.from(expected, 'hex');
  return (
    candidate.length === expectedBuffer.length &&
    crypto.timingSafeEqual(candidate, expectedBuffer)
  );
}

/**
 * Pre-authentication is an explicit system-context exception to normal
 * actor-scoped reads. It returns no password material and audits both outcomes.
 */
export async function authenticateUser(
  email: string,
  password: string,
): Promise<AuthenticatedUser | null> {
  return withActor(SYSTEM_ACTOR, async (client, traceId) => {
    const user = (
      await client.query(
        `SELECT id, email, name, password_hash, role
         FROM users WHERE email = $1 AND is_active = true`,
        [email],
      )
    ).rows[0];

    if (!user || !verifyPassword(password, user.password_hash)) {
      await auditEvent(client, 'login.failed', SYSTEM_ACTOR, {}, traceId);
      return null;
    }

    await auditEvent(
      client,
      'login.succeeded',
      SYSTEM_ACTOR,
      { userId: user.id },
      traceId,
    );
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role as Role,
    };
  });
}

/**
 * The only transaction entry point. It sets actor context before the callback
 * can issue a query, and PostgreSQL rejects writes without that context.
 */
export async function withActor<T>(
  actor: Actor,
  callback: (client: DatabaseClient, traceId: string) => Promise<T>,
  traceId: string = crypto.randomUUID(),
): Promise<T> {
  if (!actor?.id || !actor.role) throw new Error('An actor is required');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('app.current_actor_id', $1, true), set_config('app.current_actor_role', $2, true), set_config('app.request_id', $3, true)",
      [actor.id, actor.role, traceId],
    );
    const result = await callback(client, traceId);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function readAs<T>(
  actor: Actor,
  callback: (client: DatabaseClient) => Promise<T>,
): Promise<T> {
  return withActor(actor, (client) => callback(client));
}

export async function auditEvent(
  client: DatabaseClient,
  eventType: string,
  actor: Actor,
  metadata: Record<string, unknown> = {},
  traceId: string = crypto.randomUUID(),
): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(78123)');
  const previous =
    (
      await client.query(
        'SELECT row_hash FROM application_audit_events ORDER BY id DESC LIMIT 1',
      )
    ).rows[0]?.row_hash ?? '';
  const content = JSON.stringify({
    eventType,
    actorId: actor.id,
    requestId: traceId,
    metadata,
    prevHash: previous,
  });
  const rowHash = crypto.createHash('sha256').update(content).digest('hex');
  await client.query(
    `INSERT INTO application_audit_events
      (id, event_type, actor_id, request_id, metadata, prev_hash, row_hash)
     VALUES (nextval('application_audit_events_id_seq'), $1, $2, $3, $4, $5, $6)`,
    [eventType, actor.id, traceId, JSON.stringify(metadata), previous, rowHash],
  );
}

export async function logAccess(
  client: DatabaseClient,
  actor: Actor,
  resourceType: string,
  resourceId: string,
  traceId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO access_log (actor_id, resource_type, resource_id, request_id)
     VALUES ($1, $2, $3, $4)`,
    [actor.id, resourceType, resourceId, traceId],
  );
}

export async function verifyAuditChain(): Promise<boolean> {
  const rows = (await pool.query('SELECT * FROM audit_log ORDER BY id')).rows;
  let previousHash = '';

  for (const row of rows) {
    const result = await pool.query(
      `SELECT encode(digest(json_build_object(
        'tableName', $1::text,
        'rowPk', $2::text,
        'operation', $3::text,
        'beforeData', $4::jsonb,
        'afterData', $5::jsonb,
        'actorId', $6::text,
        'requestId', $7::text,
        'prevHash', $8::text
      )::text, 'sha256'), 'hex') AS hash`,
      [
        row.table_name,
        row.row_pk,
        row.operation,
        JSON.stringify(row.before_data),
        JSON.stringify(row.after_data),
        row.actor_id,
        row.request_id,
        previousHash,
      ],
    );
    if (row.prev_hash !== previousHash || row.row_hash !== result.rows[0].hash)
      return false;
    previousHash = row.row_hash;
  }
  return true;
}

export async function verifyApplicationAuditChain(): Promise<boolean> {
  const rows = (
    await pool.query('SELECT * FROM application_audit_events ORDER BY id')
  ).rows;
  let previousHash = '';
  for (const row of rows) {
    const content = JSON.stringify({
      eventType: row.event_type,
      actorId: row.actor_id,
      requestId: row.request_id,
      metadata: row.metadata,
      prevHash: previousHash,
    });
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    if (row.prev_hash !== previousHash || row.row_hash !== hash) return false;
    previousHash = row.row_hash;
  }
  return true;
}
