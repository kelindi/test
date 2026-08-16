import Link from 'next/link';

export default function HomePage() {
  return (
    <main>
      <h1>Internal tools</h1>
      <p>Audited operations reference implementation.</p>
      <p>
        <Link href="/login">Log in</Link> or{' '}
        <Link href="/refunds">open refunds</Link>.
      </p>
    </main>
  );
}
