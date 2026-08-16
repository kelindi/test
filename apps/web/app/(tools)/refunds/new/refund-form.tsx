'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { formatMoney } from '@/lib/format';
import { createRefund } from '../actions';

type PaymentOption = {
  id: string;
  externalPaymentId: string;
  amountMinor: string;
  refundedMinor: string;
  remainingMinor: string;
  currency: string;
  capturedAt: string;
};

export function RefundForm({
  customerId,
  payments,
}: {
  customerId: string;
  payments: PaymentOption[];
}) {
  const [paymentId, setPaymentId] = useState(payments[0]?.id ?? '');
  const [reason, setReason] = useState('customer_request');
  const selectedPayment = payments.find((payment) => payment.id === paymentId);

  return (
    <form action={createRefund} className="mt-6 space-y-6">
      <input type="hidden" name="customerId" value={customerId} />
      <input type="hidden" name="paymentId" value={paymentId} />
      <input type="hidden" name="source" value="manual" />
      <div>
        <p className="mb-3 text-[13px] font-medium uppercase tracking-[0.02em] text-muted-foreground">
          2. Select charge
        </p>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead aria-label="Select" />
                <TableHead>Charge</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Refunded</TableHead>
                <TableHead>Remaining</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payments.map((payment) => (
                <TableRow key={payment.id}>
                  <TableCell>
                    <input
                      type="radio"
                      name="selectedPayment"
                      value={payment.id}
                      checked={payment.id === paymentId}
                      onChange={() => setPaymentId(payment.id)}
                      aria-label={`Select ${payment.externalPaymentId}`}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-[13px]">
                    {payment.externalPaymentId}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {formatMoney(BigInt(payment.amountMinor), payment.currency)}
                  </TableCell>
                  <TableCell className="text-[13px] text-muted-foreground">
                    {payment.capturedAt}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {formatMoney(
                      BigInt(payment.refundedMinor),
                      payment.currency,
                    )}
                  </TableCell>
                  <TableCell className="font-medium tabular-nums">
                    {formatMoney(
                      BigInt(payment.remainingMinor),
                      payment.currency,
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
      {selectedPayment && (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="amount">Refund amount</Label>
            <Input
              id="amount"
              name="amount"
              defaultValue={(
                Number(selectedPayment.remainingMinor) / 100
              ).toFixed(2)}
              key={selectedPayment.id}
              inputMode="decimal"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="reasonCode">Reason</Label>
            <Select name="reasonCode" value={reason} onValueChange={setReason}>
              <SelectTrigger id="reasonCode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="duplicate">Duplicate</SelectItem>
                <SelectItem value="fraud">Fraud</SelectItem>
                <SelectItem value="customer_request">
                  Customer request
                </SelectItem>
                <SelectItem value="service_issue">Service issue</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="notes">
              Notes {reason === 'other' && <span>(required)</span>}
            </Label>
            <Textarea id="notes" name="notes" required={reason === 'other'} />
          </div>
          <Button type="submit">Submit for review</Button>
        </div>
      )}
    </form>
  );
}
