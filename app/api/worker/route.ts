import { NextResponse } from 'next/server';

import { auth } from '../../../auth';
import { FakeStripeProvider, dispatchRefund, withActor } from '@internal/core';

const provider = new FakeStripeProvider();

export async function POST() {
  const session = await auth();
  if (session?.user?.role !== 'admin')
    return new NextResponse('Forbidden', { status: 403 });
  const actor = { id: session.user.id, role: 'admin' as const };
  await withActor(actor, async (client) => {
    const items = (
      await client.query(
        "SELECT id FROM outbox WHERE status = 'pending' ORDER BY id FOR UPDATE SKIP LOCKED",
      )
    ).rows;
    for (const item of items) {
      await dispatchRefund(client, provider, actor, item.id);
    }
  });
  return NextResponse.json({ ok: true });
}
