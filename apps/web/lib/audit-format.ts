import { formatMoney } from './format';

const actorNames: Record<string, string> = {
  system: 'System',
  seed: 'Seed',
  user_support: 'Support Agent',
  user_finance_1: 'Finance Reviewer One',
  user_finance_2: 'Finance Reviewer Two',
  user_admin: 'Administrator',
};

function actorName(id: string): string {
  return actorNames[id] ?? id;
}

function formatCurrency(
  row: Record<string, unknown>,
  amountKey: string,
  fallbackCurrency = 'USD',
): string | null {
  const currency = String(row.currency ?? fallbackCurrency);
  const rawAmount = row[amountKey];
  if (
    rawAmount === null ||
    rawAmount === undefined ||
    (typeof rawAmount !== 'string' && typeof rawAmount !== 'number')
  ) {
    return null;
  }
  return formatMoney(BigInt(rawAmount), currency);
}

function sentence(parts: (string | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export function describeAudit(row: Record<string, unknown>): string {
  const actor = actorName(String(row.actor_id));
  const table = String(row.table_name);
  const operation = String(row.operation);
  const after = (row.after_data as Record<string, unknown> | undefined) ?? {};
  const before = (row.before_data as Record<string, unknown> | undefined) ?? {};

  if (table === 'refund_requests') {
    if (operation === 'INSERT') {
      const amount = formatCurrency(after, 'amount_minor');
      return sentence([
        `${actor} requested a refund of ${amount} for ${after.customer_id} / ${after.payment_id}.`,
        after.reason_code ? `Reason: ${after.reason_code}.` : null,
        after.notes ? `Notes: "${after.notes}".` : null,
      ]);
    }

    if (operation === 'UPDATE') {
      const fromState = before.state;
      const toState = after.state;
      if (fromState && toState && fromState !== toState) {
        return `${actor} changed status from ${fromState} to ${toState}.`;
      }
      return `${actor} updated the refund request.`;
    }

    if (operation === 'DELETE') {
      return `${actor} deleted the refund request.`;
    }
  }

  if (table === 'refund_approvals') {
    const decision = String(after.decision ?? 'recorded an approval');
    const comment = after.comment ? `"${after.comment}"` : null;
    return sentence([
      `${actor} ${decision} the request.`,
      comment ? `Comment: ${comment}.` : null,
    ]);
  }

  if (table === 'provider_calls') {
    return `${actor} called the payment provider (status: ${after.status ?? 'pending'}).`;
  }

  if (table === 'ledger_entries') {
    const amount = formatCurrency(after, 'amount_minor');
    return `${actor} recorded a ledger entry of ${amount}.`;
  }

  if (table === 'outbox') {
    return `${actor} queued a ${after.kind ?? 'task'} for processing.`;
  }

  return `${actor} ${operation.toLowerCase()}d a row in ${table}.`;
}

export function describeAuditWhen(row: Record<string, unknown>): string {
  const date = new Date(String(row.created_at));
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
