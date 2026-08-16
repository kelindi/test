import { createRefund } from '../actions';

export default function NewRefundPage() {
  return (
    <main>
      <h1>Raise refund request</h1>
      <form action={createRefund}>
        <label>
          Amount in USD
          <input name="amount" placeholder="25.00" required />
        </label>
        <label>
          Reason
          <select name="reasonCode" defaultValue="customer_request">
            <option value="duplicate">Duplicate</option>
            <option value="fraud">Fraud</option>
            <option value="customer_request">Customer request</option>
            <option value="service_issue">Service issue</option>
          </select>
        </label>
        <label>
          Notes
          <textarea name="notes" />
        </label>
        <input name="idempotencyKey" placeholder="Optional idempotency key" />
        <button type="submit">Submit for review</button>
      </form>
    </main>
  );
}
