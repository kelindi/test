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

  // Finance reviewers may only read audit rows tied to a refund they decided
  // on. This enforces the advertised `own_decision` condition in the
  // application layer against real approval rows, mirroring the
  // `audit_log_finance_own_decision` RLS policy rather than relying on it alone.
  if (actor.role === 'finance_reviewer') {
    values.push(actor.id);
    conditions.push(`EXISTS (
      SELECT 1 FROM refund_approvals
      WHERE approver_id = $${values.length}
        AND (
          (audit_log.table_name = 'refund_requests'
            AND refund_approvals.refund_request_id = audit_log.row_pk)
          OR (audit_log.table_name = 'refund_approvals'
            AND refund_approvals.id::text = audit_log.row_pk)
        )
    )`);
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

export async function queryRefundAudit(actor: Actor, refundId: string) {
  if (!can(actor, 'audit:read')) {
    throw new Error('Not authorized');
  }

  return readAs(actor, async (client) => {
    const approvals = await client.query(
      'SELECT id FROM refund_approvals WHERE refund_request_id = $1',
      [refundId],
    );
    const approvalsIds = approvals.rows.map((row) => String(row.id));

    const providers = await client.query(
      'SELECT id FROM provider_calls WHERE refund_request_id = $1',
      [refundId],
    );
    const providerIds = providers.rows.map((row) => String(row.id));

    const ledgers = await client.query(
      'SELECT id FROM ledger_entries WHERE refund_request_id = $1',
      [refundId],
    );
    const ledgerIds = ledgers.rows.map((row) => String(row.id));

    const values: (string | string[])[] = [
      refundId,
      approvalsIds,
      providerIds,
      ledgerIds,
    ];

    let where = `(audit_log.table_name = 'refund_requests' AND audit_log.row_pk = $1)
      OR (audit_log.table_name = 'refund_approvals' AND audit_log.row_pk = ANY($2::text[]))
      OR (audit_log.table_name = 'provider_calls' AND audit_log.row_pk = ANY($3::text[]))
      OR (audit_log.table_name = 'ledger_entries' AND audit_log.row_pk = ANY($4::text[]))`;

    if (actor.role === 'finance_reviewer') {
      values.push(actor.id);
      const actorIndex = values.length;
      where = `(${where}) AND EXISTS (
        SELECT 1 FROM refund_approvals
        WHERE approver_id = $${actorIndex}
          AND (
            (audit_log.table_name = 'refund_requests'
              AND refund_approvals.refund_request_id = audit_log.row_pk)
            OR (audit_log.table_name = 'refund_approvals'
              AND refund_approvals.id::text = audit_log.row_pk)
          )
      )`;
    }

    return (
      await client.query(
        `SELECT * FROM audit_log WHERE ${where} ORDER BY created_at ASC, id ASC`,
        values,
      )
    ).rows;
  });
}

export async function exportAudit(
  actor: Actor,
  filter: AuditFilter = {},
  format: 'csv' | 'json' = 'json',
): Promise<string> {
  const rows = await queryAudit(actor, filter);
  return format === 'csv' ? auditCsv(rows) : JSON.stringify(rows);
}
