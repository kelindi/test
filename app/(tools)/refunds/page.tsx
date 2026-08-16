import Link from 'next/link';

import { auth } from '../../../auth';
import { readAs } from '@internal/core';

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
  const rows: any[] = await readAs(
    actor,
    async (client) =>
      (
        await client.query(
          'SELECT id, amount_minor, currency, reason_code, state, created_at FROM refund_requests ORDER BY created_at DESC',
        )
      ).rows,
  );

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
            <th>Reason</th>
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
                {row.currency} {(Number(row.amount_minor) / 100).toFixed(2)}
              </td>
              <td>{row.reason_code}</td>
              <td>{row.state}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
