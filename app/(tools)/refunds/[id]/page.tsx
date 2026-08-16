import Link from 'next/link';
import crypto from 'node:crypto';

import { auth } from '../../../../auth';
import { auditEvent, logAccess, queryAudit, readAs } from '@internal/core';
import { approveRefund, rejectRefund } from '../actions';

export default async function RefundDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user)
    return (
      <main>
        <Link href="/login">Sign in</Link>
      </main>
    );
  const { id } = await params;
  const actor = {
    id: session.user.id,
    role: session.user.role as 'support_agent' | 'finance_reviewer' | 'admin',
  };
  const refund = await readAs(
    actor,
    async (client) =>
      (await client.query('SELECT * FROM refund_requests WHERE id = $1', [id]))
        .rows[0],
  );
  if (!refund) return <main>Refund not found</main>;
  await readAs(actor, async (client) => {
    const traceId = crypto.randomUUID();
    await logAccess(client, actor, 'refund_request', id, traceId);
    await auditEvent(client, 'refund.read', actor, { refundId: id }, traceId);
  });
  const audit = await queryAudit(actor, {
    tableName: 'refund_requests',
    rowPk: id,
  });

  return (
    <main>
      <h1>Refund {id}</h1>
      <p>
        {refund.currency} {(Number(refund.amount_minor) / 100).toFixed(2)} ·{' '}
        {refund.state}
      </p>
      <p>Reason: {refund.reason_code}</p>
      <p>
        Fraud signals: velocity low · refund ratio 10% · account age 2 years
      </p>
      {session.user.role === 'finance_reviewer' &&
        refund.state === 'pending_approval' && (
          <>
            <form action={approveRefund}>
              <input type="hidden" name="id" value={id} />
              <button>Approve</button>
            </form>
            <form action={rejectRefund}>
              <input type="hidden" name="id" value={id} />
              <button>Reject</button>
            </form>
          </>
        )}
      <h2>Audit history</h2>
      <ul>
        {audit.map((entry: any) => (
          <li key={`${entry.created_at}-${entry.id}`}>
            {entry.operation} by {entry.actor_id} at{' '}
            {entry.created_at.toISOString()}
          </li>
        ))}
      </ul>
      <p>
        <Link href="/refunds">Back to queue</Link>
      </p>
    </main>
  );
}
