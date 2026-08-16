import Link from 'next/link';

import { reviewerQueue } from '@internal/core';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { actorFromSession } from '@/lib/auth';
import { formatMoney } from '@/lib/format';
import { auth } from '../../../auth';

export default async function RefundQueuePage() {
  const session = await auth();
  if (!session?.user)
    return (
      <main>
        <Link href="/login">Sign in to view refunds</Link>
      </main>
    );

  const actor = actorFromSession(session);
  if (!actor) return <main>Invalid session</main>;
  const rows = await reviewerQueue(actor);

  return (
    <main className="mx-auto max-w-[1100px] px-6 py-10">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold leading-7">Refund queue</h1>
        {actor.role === 'support_agent' && (
          <Button asChild>
            <Link href="/refunds/new">Raise refund request</Link>
          </Button>
        )}
      </div>
      <div className="mt-6 rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Customer</TableHead>
              <TableHead>Amount</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Requester</TableHead>
              <TableHead>Age</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Approvals</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <Link
                    href={`/refunds/${row.id}`}
                    className="underline underline-offset-4"
                  >
                    {row.customerName}
                  </Link>
                  <div className="text-[13px] text-muted-foreground">
                    {row.customerEmail}
                  </div>
                </TableCell>
                <TableCell className="font-medium tabular-nums">
                  {formatMoney(row.requestedAmountMinor, 'USD')} /{' '}
                  {formatMoney(row.originalAmountMinor, 'USD')}
                </TableCell>
                <TableCell>{row.reasonCode}</TableCell>
                <TableCell className="font-mono text-[13px]">
                  {row.requesterId}
                </TableCell>
                <TableCell className="text-[13px] text-muted-foreground">
                  {row.age}
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{row.state}</Badge>
                </TableCell>
                <TableCell className="tabular-nums">
                  {row.approvalCount} / {row.needsTwoApprovals ? 2 : 1}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </main>
  );
}
