import { redirect } from 'next/navigation';

import { auth } from '../../../../auth';
import { actorFromSession } from '@/lib/auth';
import { can } from '@internal/core';
import { searchCustomer } from '../actions';
import { KycForm } from './kyc-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export default async function NewKycPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const actor = actorFromSession(session);
  if (!actor || !can(actor, 'kyc:create')) redirect('/kyc');

  const params = await searchParams;
  const email = params.email?.trim() ?? '';
  const customer = email ? await searchCustomer(email) : null;

  return (
    <main className="mx-auto max-w-[1100px] px-6 py-10">
      <h1 className="text-xl font-semibold leading-7">Open KYC case</h1>
      <div className="mt-6 max-w-xl">
        <p className="mb-3 text-[13px] font-medium uppercase tracking-[0.02em] text-muted-foreground">
          1. Find customer
        </p>
        <form method="get" className="flex items-end gap-3">
          <div className="flex-1 space-y-2">
            <Label htmlFor="email">Customer email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              defaultValue={email}
              required
            />
          </div>
          <Button type="submit" variant="outline">
            Search
          </Button>
        </form>
      </div>
      {customer && (
        <div className="mt-6 max-w-xl">
          <p className="text-sm">
            {customer.name} ({customer.email}) ·{' '}
            <span className="font-mono text-[13px]">{customer.externalId}</span>
          </p>
          <KycForm customerId={customer.id} />
        </div>
      )}
      {email && !customer && <p className="mt-6">No customer found.</p>}
    </main>
  );
}
