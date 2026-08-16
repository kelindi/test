import Link from 'next/link';
import { redirect } from 'next/navigation';

import { can, kycQueue } from '@internal/core';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { actorFromSession } from '@/lib/auth';
import { auth } from '../../../auth';

export default async function KycQueuePage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const actor = actorFromSession(session);
  if (!actor) redirect('/login');

  const rows = await kycQueue(actor);

  return (
    <main className="mx-auto max-w-[1100px] px-6 py-10">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold leading-7">KYC queue</h1>
        {can(actor, 'kyc:create') && (
          <Button asChild>
            <Link href="/kyc/new">Open KYC case</Link>
          </Button>
        )}
      </div>
      <div className="mt-6 rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Customer</TableHead>
              <TableHead>Risk level</TableHead>
              <TableHead>Submitter</TableHead>
              <TableHead>Age</TableHead>
              <TableHead>State</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <Link
                    href={`/kyc/${row.id}`}
                    className="underline underline-offset-4"
                  >
                    {row.customerName}
                  </Link>
                  <div className="text-[13px] text-muted-foreground">
                    {row.customerEmail}
                  </div>
                </TableCell>
                <TableCell className="font-medium uppercase">
                  {row.riskLevel}
                </TableCell>
                <TableCell className="font-mono text-[13px]">
                  {row.submitterId}
                </TableCell>
                <TableCell className="text-[13px] text-muted-foreground">
                  {row.age}
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{row.state}</Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </main>
  );
}
