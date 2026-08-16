import crypto from 'node:crypto';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { actorFromSession } from '@/lib/auth';
import { auth } from '../../../../auth';
import { can, queryAudit, readKycCase } from '@internal/core';
import { approveKyc, rejectKyc, requestInfoKyc, submitKyc } from '../actions';

const checklist = [
  'Document authenticity',
  'Face match + liveness',
  'Address match',
  'Sanctions + PEP screening',
];

export default async function KycDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const actor = actorFromSession(session);
  if (!actor) redirect('/login');

  const { id } = await params;
  const traceId = crypto.randomUUID();
  const kyc = await readKycCase(actor, id, traceId);
  if (!kyc) return <main>KYC case not found</main>;

  let audit: any[] = [];
  if (can(actor, 'audit:read')) {
    audit = await queryAudit(actor, {
      tableName: 'kyc_cases',
      rowPk: id,
    });
  }

  const resource = { state: kyc.state, requesterId: kyc.submittedBy };
  const canApprove = can(actor, 'kyc:approve', resource);
  const canReject = can(actor, 'kyc:reject', resource);
  const canRequestInfo = can(actor, 'kyc:request_info', resource);
  const canSubmit = can(actor, 'kyc:submit', resource);

  return (
    <main className="mx-auto max-w-[1100px] px-6 py-10">
      <h1 className="text-xl font-semibold leading-7">KYC case</h1>
      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-[13px] font-medium uppercase tracking-[0.02em] text-muted-foreground">
              Customer
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
              <dt className="text-muted-foreground">Name</dt>
              <dd>{kyc.customerName}</dd>
              <dt className="text-muted-foreground">Email</dt>
              <dd>{kyc.customerEmail}</dd>
              <dt className="text-muted-foreground">External ID</dt>
              <dd className="font-mono text-[13px]">
                {kyc.customerExternalId}
              </dd>
              <dt className="text-muted-foreground">Account created</dt>
              <dd>{kyc.accountCreatedAt.toISOString()}</dd>
              <dt className="text-muted-foreground">Risk level</dt>
              <dd className="font-medium uppercase">{kyc.riskLevel}</dd>
              <dt className="text-muted-foreground">Submitter</dt>
              <dd className="font-mono text-[13px]">{kyc.submittedBy}</dd>
              <dt className="text-muted-foreground">State</dt>
              <dd>
                <Badge variant="outline">{kyc.state}</Badge>
              </dd>
              <dt className="text-muted-foreground">Notes</dt>
              <dd>{kyc.notes || '—'}</dd>
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-[13px] font-medium uppercase tracking-[0.02em] text-muted-foreground">
              Verification checklist
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {checklist.map((item) => (
                <li key={item} className="flex items-center gap-2">
                  <input type="checkbox" disabled className="h-4 w-4" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-[13px] font-medium uppercase tracking-[0.02em] text-muted-foreground">
            Documents
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {kyc.documents.map((doc) => (
              <div key={doc.id} className="space-y-1">
                <p className="text-[13px] font-medium uppercase text-muted-foreground">
                  {doc.docType.replace(/_/g, ' ')}
                </p>
                <img
                  src={doc.mockImagePath}
                  alt={doc.docType}
                  className="h-32 w-full rounded-md border object-cover"
                />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {can(actor, 'audit:read') && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="text-[13px] font-medium uppercase tracking-[0.02em] text-muted-foreground">
              Audit history
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
      )}

      {(canApprove || canReject || canRequestInfo || canSubmit) && (
        <div className="mt-6">
          <p className="mb-2 text-[13px] font-medium uppercase tracking-[0.02em] text-muted-foreground">
            Decision
          </p>
          <div className="flex flex-wrap items-start gap-3">
            {canApprove && (
              <form action={approveKyc}>
                <input type="hidden" name="id" value={id} />
                <Button type="submit">Approve</Button>
              </form>
            )}
            {canReject && (
              <form action={rejectKyc} className="flex items-start gap-2">
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
            )}
            {canRequestInfo && (
              <form action={requestInfoKyc} className="flex items-start gap-2">
                <input type="hidden" name="id" value={id} />
                <Textarea
                  name="comment"
                  placeholder="Request additional information"
                  className="min-h-9 w-64"
                />
                <Button type="submit" variant="outline">
                  Request info
                </Button>
              </form>
            )}
            {canSubmit && (
              <form action={submitKyc} className="flex items-start gap-2">
                <input type="hidden" name="id" value={id} />
                <Textarea
                  name="comment"
                  placeholder="Resubmission notes"
                  className="min-h-9 w-64"
                />
                <Button type="submit" variant="outline">
                  Submit for review
                </Button>
              </form>
            )}
          </div>
        </div>
      )}

      <p className="mt-6 text-sm">
        <Link href="/kyc" className="underline underline-offset-4">
          Back to queue
        </Link>
      </p>
    </main>
  );
}
