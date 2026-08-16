import { NextResponse } from 'next/server';

import { auth } from '../../../auth';
import {
  FakeStripeProvider,
  claimNext,
  dispatchRefund,
  sweepExecuting,
  SYSTEM_ACTOR,
  withActor,
} from '@internal/core';

const provider = new FakeStripeProvider();

export async function POST() {
  const session = await auth();
  if (session?.user?.role !== 'admin')
    return new NextResponse('Forbidden', { status: 403 });

  await withActor(SYSTEM_ACTOR, async (client) => {
    for (;;) {
      const item = await claimNext(client);
      if (!item) break;
      await dispatchRefund(client, provider, SYSTEM_ACTOR, {
        id: item.id,
        payload: item.payload as {
          refundId: string;
          paymentId: string;
          amountMinor: string;
          idempotencyKey: string;
        },
      });
    }

    await sweepExecuting(client, provider);
  });

  return NextResponse.json({ ok: true });
}
