import type { Action, Actor } from './authz';
import { can } from './authz';

export type Transition<State extends string> = {
  from: State;
  to: State;
  action: Action | string;
  guard?: (actor: Actor, resource: Record<string, unknown>) => boolean;
  requiresDifferentActorFrom?: string;
};

export type TransitionHistory = {
  transition: string;
  actorId: string;
};

/**
 * Declarative transitions centralize permission and segregation-of-duties guards.
 */
export class StateMachine<State extends string> {
  constructor(private readonly transitions: Transition<State>[]) {}

  transition(
    state: State,
    nextState: State,
    actor: Actor,
    action: Action | string,
    history: TransitionHistory[],
    resource: Record<string, unknown> = {},
  ): State {
    const rule = this.transitions.find(
      (candidate) =>
        candidate.from === state &&
        candidate.to === nextState &&
        candidate.action === action,
    );
    if (!rule) {
      throw new Error('Transition is not permitted');
    }
    if (action.includes(':') && !can(actor, action as Action, resource)) {
      const requester = (resource.requestedBy ?? resource.requesterId) as
        | string
        | undefined;
      const approvals = (resource.approvalActorIds ?? []) as string[];
      if (
        (action === 'refund:approve' ||
          action === 'refund:reject' ||
          action === 'kyc:approve' ||
          action === 'kyc:reject') &&
        (requester === actor.id || approvals.includes(actor.id))
      ) {
        throw new Error('Segregation of duties violation');
      }
      throw new Error('Transition is not permitted: not authorized');
    }
    if (rule.guard && !rule.guard(actor, resource))
      throw new Error('Transition guard failed');
    if (
      rule.requiresDifferentActorFrom &&
      history.some(
        (entry) =>
          entry.transition === rule.requiresDifferentActorFrom &&
          entry.actorId === actor.id,
      )
    ) {
      throw new Error('Segregation of duties violation');
    }
    return nextState;
  }
}

export const kycTransitions: Transition<string>[] = [
  {
    from: 'pending_review',
    to: 'approved',
    action: 'kyc:approve',
    guard: () => true,
    requiresDifferentActorFrom: 'kyc:create',
  },
  {
    from: 'pending_review',
    to: 'rejected',
    action: 'kyc:reject',
    guard: () => true,
    requiresDifferentActorFrom: 'kyc:create',
  },
  {
    from: 'pending_review',
    to: 'needs_more_info',
    action: 'kyc:request_info',
    guard: () => true,
  },
  {
    from: 'needs_more_info',
    to: 'pending_review',
    action: 'kyc:submit',
    guard: () => true,
  },
];

export const refundTransitions: Transition<string>[] = [
  {
    from: 'pending_approval',
    to: 'approved',
    action: 'refund:approve',
    guard: () => true,
    requiresDifferentActorFrom: 'refund:create',
  },
  {
    from: 'pending_approval',
    to: 'rejected',
    action: 'refund:reject',
    guard: () => true,
    requiresDifferentActorFrom: 'refund:create',
  },
  {
    from: 'approved',
    to: 'executing',
    action: 'refund:retry',
    guard: () => true,
  },
  { from: 'failed', to: 'approved', action: 'refund:retry', guard: () => true },
  {
    from: 'pending_approval',
    to: 'cancelled',
    action: 'refund:cancel',
    guard: () => true,
  },
  {
    from: 'failed',
    to: 'cancelled',
    action: 'refund:abandon',
    guard: () => true,
  },
];
