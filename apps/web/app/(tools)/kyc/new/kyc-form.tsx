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
import { Textarea } from '@/components/ui/textarea';
import { createKyc } from '../actions';

export function KycForm({ customerId }: { customerId: string }) {
  const [riskLevel, setRiskLevel] = useState('medium');
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  return (
    <form action={createKyc} className="mt-6 space-y-6">
      <input type="hidden" name="customerId" value={customerId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <div className="space-y-2">
        <Label htmlFor="riskLevel">Risk level</Label>
        <Select name="riskLevel" value={riskLevel} onValueChange={setRiskLevel}>
          <SelectTrigger id="riskLevel">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="low">Low</SelectItem>
            <SelectItem value="medium">Medium</SelectItem>
            <SelectItem value="high">High</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="notes">
          Notes {riskLevel === 'high' && <span>(required)</span>}
        </Label>
        <Textarea
          id="notes"
          name="notes"
          required={riskLevel === 'high'}
          maxLength={1000}
        />
      </div>
      <Button type="submit">Submit for review</Button>
    </form>
  );
}
