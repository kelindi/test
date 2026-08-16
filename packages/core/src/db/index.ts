import 'dotenv/config';

import crypto from 'node:crypto';
import pg from 'pg';

import type { Actor } from '../authz';

type PoolClient = pg.PoolClient;

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});

export async function withActor<T>(
  actor: Actor,
  callback: (client: PoolClient, traceId: string) => Promise<T>,
  traceId = crypto.randomUUID(),
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
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withActor(actor, (client) => callback(client));
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

    if (
      row.prev_hash !== previousHash ||
      row.row_hash !== result.rows[0].hash
    ) {
      return false;
    }
    previousHash = row.row_hash;
  }

  return true;
}
