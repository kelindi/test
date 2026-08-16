/**
 * Authorization is deliberately a small policy boundary. An external policy
 * engine can replace this implementation without changing application calls.
 */
export type Role = 'support_agent' | 'finance_reviewer' | 'admin';

export type Actor = {
  id: string;
  role: Role;
};

export type Action =
  | 'refund:create'
  | 'refund:read'
  | 'refund:approve'
  | 'refund:reject'
  | 'refund:retry'
  | 'audit:read'
  | 'audit:export';

export type RefundResource = {
  state?: string;
  requesterId?: string;
  approvals?: string[];
};

export function can(
  actor: Actor,
  action: Action,
  resource: RefundResource = {},
): boolean {
  if (actor.role === 'admin') {
    return (
      action === 'audit:read' ||
      action === 'audit:export' ||
      action === 'refund:read'
    );
  }

  if (actor.role === 'support_agent') {
    return action === 'refund:create' || action === 'refund:read';
  }

  if (actor.role === 'finance_reviewer') {
    if (action === 'refund:read') return true;
    if (action === 'refund:approve' || action === 'refund:reject') {
      return (
        resource.state === 'pending_approval' &&
        resource.requesterId !== actor.id &&
        !resource.approvals?.includes(actor.id)
      );
    }
    if (action === 'refund:retry') return resource.state === 'failed';
  }

  return false;
}
