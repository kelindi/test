/**
 * Authorization is a single policy boundary. A future policy engine can replace
 * this function without changing application call sites.
 */
export type Role = 'support_agent' | 'finance_reviewer' | 'admin';

export type Actor = {
  id: string;
  role: Role;
};

export const SYSTEM_ACTOR: Actor = {
  id: 'system',
  role: 'admin',
};

export type Action =
  | 'refund:create'
  | 'refund:read'
  | 'refund:approvals:read'
  | 'refund:approve'
  | 'refund:reject'
  | 'refund:retry'
  | 'refund:cancel'
  | 'refund:abandon'
  | 'audit:read'
  | 'audit:export';

export type RefundResource = {
  state?: string;
  requestedBy?: string;
  requesterId?: string;
  approvalActorIds?: string[];
};

export function can(
  actor: Actor,
  action: Action,
  resource: RefundResource = {},
): boolean {
  const requester = resource.requestedBy ?? resource.requesterId;
  const approvals = resource.approvalActorIds ?? [];

  if (actor.role === 'support_agent') {
    if (
      action === 'refund:create' ||
      action === 'refund:read' ||
      action === 'refund:approvals:read'
    )
      return true;
    return (
      action === 'refund:cancel' &&
      requester === actor.id &&
      resource.state === 'pending_approval'
    );
  }

  if (actor.role === 'finance_reviewer') {
    if (action === 'refund:read' || action === 'refund:approvals:read')
      return true;
    if (action === 'refund:approve' || action === 'refund:reject') {
      return (
        resource.state === 'pending_approval' &&
        requester !== actor.id &&
        !approvals.includes(actor.id)
      );
    }
    if (action === 'refund:retry') return resource.state === 'failed';
    if (action === 'audit:read') return approvals.includes(actor.id);
    return false;
  }

  if (actor.role === 'admin') {
    if (
      action === 'refund:read' ||
      action === 'refund:approvals:read' ||
      action === 'audit:read' ||
      action === 'audit:export'
    )
      return true;
    if (action === 'refund:retry') return resource.state === 'failed';
    if (action === 'refund:cancel')
      return requester === actor.id && resource.state === 'pending_approval';
    if (action === 'refund:abandon') return resource.state === 'failed';
  }

  return false;
}
