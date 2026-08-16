import { signIn } from '../../auth';
import { redirect } from 'next/navigation';

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
    <main>
      <h1>Sign in</h1>
      <form action={login}>
        <label>
          Email
          <input name="email" type="email" required />
        </label>
        <label>
          Password
          <input name="password" type="password" required />
        </label>
        <button type="submit">Sign in</button>
      </form>
      {error && <p>Invalid email or password.</p>}
      <p>Demo accounts are documented in README.md.</p>
    </main>
  );
}
