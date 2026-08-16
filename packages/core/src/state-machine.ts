import type { Actor } from './authz';

export type Transition<State extends string> = {
  from: State;
  to: State;
  action: string;
  requiresDifferentActorFrom?: string;
};

export type TransitionHistory = {
  transition: string;
  actorId: string;
};

/**
 * State transitions are declared data, making SoD rules reusable across tools.
 */
export class StateMachine<State extends string> {
  constructor(private readonly transitions: Transition<State>[]) {}

  transition(
    state: State,
    nextState: State,
    actor: Actor,
    action: string,
    history: TransitionHistory[],
  ): State {
    const rule = this.transitions.find(
      (candidate) =>
        candidate.from === state &&
        candidate.to === nextState &&
        candidate.action === action,
    );

    if (!rule) throw new Error('Transition is not permitted');

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
