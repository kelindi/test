import { signIn } from '../../auth';

export default function LoginPage() {
  async function login(formData: FormData) {
    'use server';
    await signIn('credentials', {
      email: String(formData.get('email')),
      password: String(formData.get('password')),
      redirectTo: '/refunds',
    });
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
      <p>Demo accounts are documented in README.md.</p>
    </main>
  );
}
