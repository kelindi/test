'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { signIn } from 'next-auth/react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export default function LoginPage() {
  const searchParams = useSearchParams();
  const urlError = searchParams.get('error');
  const [error, setError] = useState(urlError);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    const formData = new FormData(event.currentTarget);
    const result = await signIn('credentials', {
      email: String(formData.get('email')),
      password: String(formData.get('password')),
      redirect: false,
      callbackUrl: '/',
    });
    setPending(false);
    if (result?.error) {
      setError(result.error);
      return;
    }
    window.location.href = result?.url || '/';
  }

  return (
    <main className="flex min-h-screen items-center justify-center">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" name="password" type="password" required />
            </div>
            <Button type="submit" className="w-full" disabled={pending}>
              Sign in
            </Button>
          </form>
          {error && <p className="mt-4 text-sm">Invalid email or password.</p>}
          <p className="mt-4 text-sm text-muted-foreground">
            Demo accounts are documented in README.md.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
