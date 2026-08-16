import Link from 'next/link';

import type { Actor } from '@internal/core';
import { Button } from '@/components/ui/button';
import { signOut } from '../auth';

export function AppHeader({
  actor,
  email,
}: {
  actor: Actor;
  email: string | null | undefined;
}) {
  async function logout() {
    'use server';
    await signOut({ redirectTo: '/login' });
  }

  return (
    <header className="border-b">
      <div className="mx-auto flex max-w-[1100px] items-center justify-between px-6 py-4">
        <Link href="/" className="text-sm font-medium">
          Internal tools
        </Link>
        <div className="flex items-center gap-4 text-[13px] text-muted-foreground">
          <span>
            {email} · {actor.role}
          </span>
          <form action={logout}>
            <Button type="submit" variant="outline" size="sm">
              Sign out
            </Button>
          </form>
        </div>
      </div>
    </header>
  );
}
