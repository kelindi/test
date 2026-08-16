import type { Actor, Role } from '@internal/core';
import type { Session } from 'next-auth';

const roles: readonly Role[] = [
  'support_agent',
  'finance_reviewer',
  'kyc_reviewer',
  'admin',
];

function isRole(value: string): value is Role {
  return roles.includes(value as Role);
}

export function actorFromSession(session: Session | null): Actor | null {
  if (!session?.user || !isRole(session.user.role)) return null;
  return { id: session.user.id, role: session.user.role };
}
