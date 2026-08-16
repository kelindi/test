import Link from 'next/link';
import { redirect } from 'next/navigation';

import { actorFromSession } from '@/lib/auth';
import { can } from '@internal/core';
import { auth } from '../../../../auth';
import { FlagForm } from './flag-form';

export default async function NewFlagPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const actor = actorFromSession(session);
  if (!actor || !can(actor, 'flag:read')) redirect('/login');
  if (!can(actor, 'flag:create')) redirect('/feature-flags');

  return (
    <main className="mx-auto max-w-[1100px] px-6 py-10">
      <h1 className="text-xl font-semibold leading-7">New feature flag</h1>
      <div className="mt-6 max-w-xl">
        <FlagForm />
      </div>
      <p className="mt-6 text-sm">
        <Link href="/feature-flags" className="underline underline-offset-4">
          Back to flags
        </Link>
      </p>
    </main>
  );
}
