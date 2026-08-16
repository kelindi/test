import type { Actor } from './authz';
import { can } from './authz';
import { readAs } from './db';

export type AuditFilter = {
  tableName?: string;
  rowPk?: string;
  actorId?: string;
  operation?: string;
};

export async function queryAudit(actor: Actor, filter: AuditFilter = {}) {
  if (!can(actor, 'audit:read')) {
    throw new Error('Not authorized');
  }
  const conditions: string[] = [];
  const values: string[] = [];

  for (const [column, value] of [
    ['table_name', filter.tableName],
    ['row_pk', filter.rowPk],
    ['actor_id', filter.actorId],
    ['operation', filter.operation],
  ] as const) {
    if (value) {
      values.push(value);
      conditions.push(`${column} = $${values.length}`);
    }
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return readAs(
    actor,
    async (client) =>
      (
        await client.query(
          `SELECT * FROM audit_log ${where} ORDER BY created_at DESC, id DESC`,
          values,
        )
      ).rows,
  );
}

export function auditCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const columns = Object.keys(rows[0]);
  const escape = (value: unknown) => {
    const serialized =
      value === null || value === undefined
        ? ''
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value);
    return `"${serialized.replaceAll('"', '""')}"`;
  };
  return [
    columns.join(','),
    ...rows.map((row) =>
      columns.map((column) => escape(row[column])).join(','),
    ),
  ].join('\n');
}

export async function exportAudit(
  actor: Actor,
  filter: AuditFilter = {},
  format: 'csv' | 'json' = 'json',
): Promise<string> {
  const rows = await queryAudit(actor, filter);
  return format === 'csv' ? auditCsv(rows) : JSON.stringify(rows);
}
