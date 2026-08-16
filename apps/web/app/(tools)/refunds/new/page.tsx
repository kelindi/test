import { createRefund, listCustomerPayments, searchCustomer } from '../actions';
import { redirect } from 'next/navigation';
import { auth } from '../../../../auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RefundForm } from './refund-form';

export default async function NewRefundPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const params = await searchParams;
  const email = params.email?.trim() ?? '';
  const customer = email ? await searchCustomer(email) : null;
  const payments = customer ? await listCustomerPayments(customer.id) : [];

  return (
    <main className="mx-auto max-w-[1100px] px-6 py-10">
      <h1 className="text-xl font-semibold leading-7">Raise refund request</h1>
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
        <div className="mt-6 max-w-[900px]">
          <p className="text-sm">
            {customer.name} ({customer.email}) ·{' '}
            <span className="font-mono text-[13px]">{customer.externalId}</span>
          </p>
          <RefundForm
            customerId={customer.id}
            payments={payments.map((payment) => ({
              ...payment,
              amountMinor: payment.amountMinor.toString(),
              refundedMinor: payment.refundedMinor.toString(),
              remainingMinor: payment.remainingMinor.toString(),
            }))}
          />
        </div>
      )}
      {email && !customer && <p>No customer found.</p>}
    </main>
  );
}
