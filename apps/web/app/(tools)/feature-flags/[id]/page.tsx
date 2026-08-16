import Link from 'next/link';
import { redirect } from 'next/navigation';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { actorFromSession } from '@/lib/auth';
import { can, queryAudit, readFlag } from '@internal/core';
import { auth } from '../../../../auth';
import { toggleFlagAction } from '../actions';

export default async function FeatureFlagDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const { id } = await params;
  const actor = actorFromSession(session);
  if (!actor) redirect('/login');
  if (!can(actor, 'flag:read')) redirect('/login');

  const flag = await readFlag(actor, id);
  if (!flag) return <main>Flag not found</main>;

  const canToggle = can(actor, 'flag:toggle');
  let audit: any[] = [];
  if (can(actor, 'audit:read')) {
    audit = await queryAudit(actor, {
      tableName: 'feature_flags',
      rowPk: id,
    });
  }

  return (
    <main className="mx-auto max-w-[1100px] px-6 py-10">
      <h1 className="text-xl font-semibold leading-7">Feature flag</h1>
      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-[13px] font-medium uppercase tracking-[0.02em] text-muted-foreground">
              Flag
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
              <dt className="text-muted-foreground">Key</dt>
              <dd className="font-mono text-[13px]">{flag.key}</dd>
              <dt className="text-muted-foreground">Description</dt>
              <dd>{flag.description}</dd>
              <dt className="text-muted-foreground">Environment</dt>
              <dd>{flag.environment}</dd>
              <dt className="text-muted-foreground">State</dt>
              <dd>
                <Badge variant={flag.enabled ? 'default' : 'outline'}>
                  {flag.enabled ? 'Enabled' : 'Disabled'}
                </Badge>
              </dd>
              <dt className="text-muted-foreground">Last updated by</dt>
              <dd className="font-mono text-[13px]">{flag.updatedBy}</dd>
            </dl>
            {canToggle && (
              <form action={toggleFlagAction} className="pt-2">
                <input type="hidden" name="id" value={id} />
                <input
                  type="hidden"
                  name="enabled"
                  value={String(!flag.enabled)}
                />
                <Button
                  type="submit"
                  variant={flag.enabled ? 'outline' : 'default'}
                >
                  {flag.enabled ? 'Disable flag' : 'Enable flag'}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-[13px] font-medium uppercase tracking-[0.02em] text-muted-foreground">
              Change history
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3 text-sm">
              {audit.map((entry: any) => (
                <li key={`${entry.created_at}-${entry.id}`}>
                  <span className="font-medium">{entry.operation}</span>
                  <span className="text-muted-foreground">
                    {' by '}
                    {entry.actor_id}
                    {' at '}
                    {entry.created_at.toISOString()}
                  </span>
                </li>
              ))}
              {audit.length === 0 && (
                <li className="text-muted-foreground">No audit entries</li>
              )}
            </ul>
          </CardContent>
        </Card>
      </div>
      <p className="mt-6 text-sm">
        <Link href="/feature-flags" className="underline underline-offset-4">
          Back to flags
        </Link>
      </p>
    </main>
  );
}
