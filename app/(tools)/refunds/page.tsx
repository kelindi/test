import Link from 'next/link';

import { auth } from '../../../auth';
import { reviewerQueue } from '@internal/core';

export default async function RefundQueuePage() {
  const session = await auth();
  if (!session?.user)
    return (
      <main>
        <Link href="/login">Sign in to view refunds</Link>
      </main>
    );

  const actor = {
    id: session.user.id,
    role: session.user.role as 'support_agent' | 'finance_reviewer' | 'admin',
  };
  const rows = await reviewerQueue(actor);

  return (
    <main>
      <h1>Refund review queue</h1>
      <p>
        Signed in as {session.user.email} ({session.user.role})
      </p>
      {session.user.role === 'support_agent' && (
        <Link href="/refunds/new">Raise refund request</Link>
      )}
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Amount</th>
            <th>Customer</th>
            <th>Reason</th>
            <th>Requester</th>
            <th>Age</th>
            <th>Approvals</th>
            <th>Source</th>
            <th>State</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                <Link href={`/refunds/${row.id}`}>{row.id}</Link>
              </td>
              <td>
                ${(Number(row.requestedAmountMinor) / 100).toFixed(2)} / $
                {(Number(row.originalAmountMinor) / 100).toFixed(2)}
              </td>
              <td>
                {row.customerName} ({row.customerEmail})
              </td>
              <td>{row.reasonCode}</td>
              <td>{row.requesterId}</td>
              <td>{row.age}</td>
              <td>
                {row.approvalCount} / {row.needsTwoApprovals ? 2 : 1}
              </td>
              <td>{row.source}</td>
              <td>{row.state}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
