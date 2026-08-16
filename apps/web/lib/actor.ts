import type { Actor, Role } from '@internal/core';
import type { Session } from 'next-auth';

const roles: readonly Role[] = [
  'support_agent',
  'finance_reviewer',
  'admin',
  'engineering_team',
];

function isRole(value: string): value is Role {
  return roles.includes(value as Role);
}

export function actorFromSession(session: Session | null): Actor | null {
  if (!session?.user || !isRole(session.user.role)) return null;
  return { id: session.user.id, role: session.user.role };
}
