import { NextResponse } from 'next/server';

import { auth } from '../../../../auth';
import { auditCsv, queryAudit, verifyAuditChain } from '@internal/core';

export async function GET(request: Request) {
  const session = await auth();
  if (session?.user?.role !== 'admin')
    return new NextResponse('Forbidden', { status: 403 });
  const url = new URL(request.url);
  const actor = { id: session.user.id, role: 'admin' as const };
  const rows = await queryAudit(actor, {
    tableName: url.searchParams.get('table') ?? undefined,
    rowPk: url.searchParams.get('rowPk') ?? undefined,
  });
  const chainValid = await verifyAuditChain();
  if (!chainValid)
    return new NextResponse('Audit chain verification failed', { status: 500 });
  if (url.searchParams.get('format') === 'json') {
    return NextResponse.json({ chainValid, rows });
  }
  return new NextResponse(auditCsv(rows), {
    headers: {
      'content-type': 'text/csv',
      'content-disposition': 'attachment; filename="audit-export.csv"',
    },
  });
}
