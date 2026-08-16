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
  | 'customer:search'
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

export type Capability = {
  role: Role;
  action: Action;
  states?: readonly string[];
};

const policyTable: Record<
  Role,
  Partial<Record<Action, readonly string[] | true>>
> = {
  support_agent: {
    'customer:search': true,
    'refund:create': true,
    'refund:read': true,
    'refund:approvals:read': true,
    'refund:cancel': ['pending_approval'],
  },
  finance_reviewer: {
    'customer:search': true,
    'refund:read': true,
    'refund:approvals:read': true,
    'refund:approve': ['pending_approval'],
    'refund:reject': ['pending_approval'],
    'refund:retry': ['failed'],
    'audit:read': true,
  },
  admin: {
    'customer:search': true,
    'refund:read': true,
    'refund:approvals:read': true,
    'refund:retry': ['failed'],
    'refund:cancel': ['pending_approval'],
    'refund:abandon': ['failed'],
    'audit:read': true,
    'audit:export': true,
  },
};

export function capabilityMatrix(): Capability[] {
  return (
    Object.entries(policyTable) as [Role, (typeof policyTable)[Role]][]
  ).flatMap(([role, actions]) =>
    (Object.entries(actions) as [Action, true | readonly string[]][]).map(
      ([action, states]) => ({
        role,
        action,
        ...(states === true ? {} : { states }),
      }),
    ),
  );
}

export function can(
  actor: Actor,
  action: Action,
  resource: RefundResource = {},
): boolean {
  const requester = resource.requestedBy ?? resource.requesterId;
  const approvals = resource.approvalActorIds ?? [];

  const capability = policyTable[actor.role][action];
  if (!capability) return false;
  if (capability !== true && !capability.includes(resource.state ?? '')) {
    return false;
  }
  if (action === 'refund:cancel') return requester === actor.id;
  if (action === 'refund:approve' || action === 'refund:reject') {
    return requester !== actor.id && !approvals.includes(actor.id);
  }
  if (action === 'audit:read' && actor.role === 'finance_reviewer') {
    return approvals.includes(actor.id);
  }
  return true;
}
