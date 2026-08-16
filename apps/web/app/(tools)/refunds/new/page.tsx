import { createRefund, listCustomerPayments, searchCustomer } from '../actions';

export default async function NewRefundPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string }>;
}) {
  const params = await searchParams;
  const email = params.email?.trim() ?? '';
  const customer = email ? await searchCustomer(email) : null;
  const payments = customer ? await listCustomerPayments(customer.id) : [];

  return (
    <main>
      <h1>Raise refund request</h1>
      <h2>1. Find customer</h2>
      <form method="get">
        <label>
          Customer email
          <input name="email" type="email" defaultValue={email} required />
        </label>
        <button type="submit">Search</button>
      </form>
      {customer && (
        <>
          <h2>2. Select charge</h2>
          <p>
            {customer.name} ({customer.email}) · {customer.externalId}
          </p>
          <form action={createRefund}>
            <input type="hidden" name="customerId" value={customer.id} />
            <input type="hidden" name="source" value="manual" />
            <label>
              Charge
              <select name="paymentId" required>
                {payments.map((payment) => {
                  return (
                    <option key={payment.id} value={payment.id}>
                      {payment.externalPaymentId} · {payment.currency}{' '}
                      {(Number(payment.amountMinor) / 100).toFixed(2)} ·
                      refunded{' '}
                      {(Number(payment.refundedMinor) / 100).toFixed(2)} ·
                      remaining{' '}
                      {(Number(payment.remainingMinor) / 100).toFixed(2)}
                    </option>
                  );
                })}
              </select>
            </label>
            <label>
              Refund amount in USD
              <input
                name="amount"
                defaultValue={
                  payments[0]
                    ? (Number(payments[0].remainingMinor) / 100).toFixed(2)
                    : undefined
                }
                placeholder="25.00"
                required
              />
            </label>
            <label>
              Reason
              <select name="reasonCode" defaultValue="customer_request">
                <option value="duplicate">Duplicate</option>
                <option value="fraud">Fraud</option>
                <option value="customer_request">Customer request</option>
                <option value="service_issue">Service issue</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label>
              Notes
              <textarea name="notes" />
            </label>
            <input
              name="idempotencyKey"
              placeholder="Optional idempotency key"
            />
            <button type="submit">Submit for review</button>
          </form>
        </>
      )}
      {email && !customer && <p>No customer found.</p>}
    </main>
  );
}
