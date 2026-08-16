import { signIn } from '../../auth';
import { redirect } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  async function login(formData: FormData) {
    'use server';
    try {
      const result = (await signIn('credentials', {
        email: String(formData.get('email')),
        password: String(formData.get('password')),
        redirect: false,
      })) as { error?: string } | undefined;
      if (result?.error) redirect('/login?error=1');
    } catch {
      redirect('/login?error=1');
    }
    redirect('/refunds');
  }

  return (
    <main className="flex min-h-screen items-center justify-center">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={login} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" name="password" type="password" required />
            </div>
            <Button type="submit" className="w-full">
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
