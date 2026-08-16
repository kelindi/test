import Link from 'next/link';
import { redirect } from 'next/navigation';

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
import { can, flagList } from '@internal/core';
import { auth } from '../../../auth';
import { toggleFlagAction } from './actions';

export default async function FeatureFlagsPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const actor = actorFromSession(session);
  if (!actor) redirect('/login');
  if (!can(actor, 'flag:read')) redirect('/login');

  const rows = await flagList(actor);
  const canToggle = can(actor, 'flag:toggle');

  return (
    <main className="mx-auto max-w-[1100px] px-6 py-10">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold leading-7">Feature flags</h1>
        {can(actor, 'flag:create') && (
          <Button asChild>
            <Link href="/feature-flags/new">New flag</Link>
          </Button>
        )}
      </div>
      <div className="mt-6 rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Key</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Environment</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Last updated by</TableHead>
              <TableHead>Age</TableHead>
              <TableHead>Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <Link
                    href={`/feature-flags/${row.id}`}
                    className="underline underline-offset-4"
                  >
                    {row.key}
                  </Link>
                </TableCell>
                <TableCell>{row.description}</TableCell>
                <TableCell>{row.environment}</TableCell>
                <TableCell>
                  <Badge variant={row.enabled ? 'default' : 'outline'}>
                    {row.enabled ? 'Enabled' : 'Disabled'}
                  </Badge>
                </TableCell>
                <TableCell className="font-mono text-[13px]">
                  {row.updatedBy}
                </TableCell>
                <TableCell className="text-[13px] text-muted-foreground">
                  {row.age}
                </TableCell>
                <TableCell>
                  {canToggle && (
                    <form action={toggleFlagAction} className="inline">
                      <input type="hidden" name="id" value={row.id} />
                      <input
                        type="hidden"
                        name="enabled"
                        value={String(!row.enabled)}
                      />
                      <Button
                        type="submit"
                        variant={row.enabled ? 'outline' : 'default'}
                        size="sm"
                      >
                        {row.enabled ? 'Disable' : 'Enable'}
                      </Button>
                    </form>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </main>
  );
}
