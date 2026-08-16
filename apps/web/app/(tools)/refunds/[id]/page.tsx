import Link from 'next/link';
import crypto from 'node:crypto';
import { redirect } from 'next/navigation';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { actorFromSession } from '@/lib/auth';
import { formatMoney } from '@/lib/format';
import {
  auditEvent,
  can,
  FakeStripeProvider,
  logAccess,
  queryAudit,
  readAs,
  refundableBalance,
  SeededPaymentsClient,
} from '@internal/core';
import { approveRefund, rejectRefund } from '../actions';
import { auth } from '../../../../auth';

export default async function RefundDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect('/login');
  const { id } = await params;
  const actor = actorFromSession(session);
  if (!actor) redirect('/login');
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
  let audit: any[] = [];
  if (can(actor, 'audit:read')) {
    audit = await queryAudit(actor, {
      tableName: 'refund_requests',
      rowPk: id,
    });
  }
  const payment = await readAs(actor, async (client) => {
    const payments = new SeededPaymentsClient(client, new FakeStripeProvider());
    const selected = await payments.getPayment(refund.payment_id);
    if (!selected) return null;
    const inFlight = (
      await client.query(
        `SELECT COALESCE(sum(amount_minor), 0) AS amount
         FROM refund_requests
         WHERE payment_id = $1
           AND state IN ('pending_approval', 'approved', 'executing')
           AND id <> $2`,
        [refund.payment_id, id],
      )
    ).rows[0].amount;
    return {
      ...selected,
      remainingMinor: refundableBalance(
        selected.amountMinor,
        selected.refundedMinor,
        BigInt(inFlight),
      ),
    };
  });

  return (
    <main className="mx-auto max-w-[1100px] px-6 py-10">
      <h1 className="text-xl font-semibold leading-7">Refund request</h1>
      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-[13px] font-medium uppercase tracking-[0.02em] text-muted-foreground">
              Request
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
              <dt className="text-muted-foreground">Customer</dt>
              <dd>{refund.customer_id}</dd>
              <dt className="text-muted-foreground">Charge</dt>
              <dd className="font-mono text-[13px]">{refund.payment_id}</dd>
              <dt className="text-muted-foreground">Amount</dt>
              <dd className="font-medium tabular-nums">
                {formatMoney(BigInt(refund.amount_minor), refund.currency)}
                {payment && (
                  <span className="text-[13px] text-muted-foreground">
                    {' '}
                    / {formatMoney(
                      payment.remainingMinor,
                      payment.currency,
                    )}{' '}
                    remaining
                  </span>
                )}
              </dd>
              <dt className="text-muted-foreground">Reason</dt>
              <dd>{refund.reason_code}</dd>
              <dt className="text-muted-foreground">Source</dt>
              <dd>{refund.source}</dd>
              <dt className="text-muted-foreground">Notes</dt>
              <dd>{refund.notes || '—'}</dd>
              <dt className="text-muted-foreground">State</dt>
              <dd>
                <Badge variant="outline">{refund.state}</Badge>
              </dd>
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-[13px] font-medium uppercase tracking-[0.02em] text-muted-foreground">
              Approval history
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3 text-sm">
              {audit.map((entry: any) => (
                <li key={`${entry.created_at}-${entry.id}`}>
                  <span className="font-medium">{entry.operation}</span>{' '}
                  <span className="text-muted-foreground">
                    by {entry.actor_id} at {entry.created_at.toISOString()}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
      {actor.role === 'finance_reviewer' &&
        refund.state === 'pending_approval' && (
          <div className="mt-6">
            <p className="mb-2 text-[13px] font-medium uppercase tracking-[0.02em] text-muted-foreground">
              Decision
            </p>
            <div className="flex items-start gap-3">
              <form action={approveRefund}>
                <input type="hidden" name="id" value={id} />
                <Button type="submit">Approve</Button>
              </form>
              <form action={rejectRefund} className="flex items-start gap-2">
                <input type="hidden" name="id" value={id} />
                <Textarea
                  name="comment"
                  placeholder="Optional comment"
                  className="min-h-9 w-64"
                />
                <Button
                  type="submit"
                  variant="outline"
                  className="border-destructive text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  Reject
                </Button>
              </form>
            </div>
          </div>
        )}
      <p className="mt-6 text-sm">
        <Link href="/refunds" className="underline underline-offset-4">
          Back to queue
        </Link>
      </p>
    </main>
  );
}
