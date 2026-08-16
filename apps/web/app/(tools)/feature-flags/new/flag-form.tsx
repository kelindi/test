'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

import { createFlagAction } from '../actions';

export function FlagForm() {
  const [initialEnabled, setInitialEnabled] = useState('false');

  return (
    <form action={createFlagAction} className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="key">Key</Label>
        <Input
          id="key"
          name="key"
          placeholder="e.g. new_checkout_flow"
          required
          maxLength={100}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="description">Description</Label>
        <Textarea
          id="description"
          name="description"
          placeholder="What does this flag control?"
          required
          maxLength={500}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="environment">Environment</Label>
        <Input
          id="environment"
          name="environment"
          placeholder="e.g. production, staging"
          required
          maxLength={50}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="initialEnabled">Initial state</Label>
        <Select
          name="initialEnabled"
          value={initialEnabled}
          onValueChange={setInitialEnabled}
        >
          <SelectTrigger id="initialEnabled">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="false">Disabled</SelectItem>
            <SelectItem value="true">Enabled</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Button type="submit">Create flag</Button>
    </form>
  );
}
