import { describe, expect, it } from 'vitest';

import {
  authenticateUser,
  can,
  type Action,
} from '../../packages/core/src/index';
import type { Session } from 'next-auth';

import { actorFromSession } from './lib/actor';
import { availableTools, toolRegistry } from './tool-registry';

describe('portal access', () => {
  it('lists exactly the tools each seeded account can open', async () => {
    const accounts = [
      ['support@example.com', 'support-password', 'support_agent'],
      ['finance1@example.com', 'finance-password', 'finance_reviewer'],
      ['finance2@example.com', 'finance-two-password', 'finance_reviewer'],
      ['admin@example.com', 'admin-password', 'admin'],
    ] as const;

    for (const [email, password, role] of accounts) {
      const user = await authenticateUser(email, password);
      expect(user?.role).toBe(role);
      const session: Session = {
        user: user!,
        expires: new Date(Date.now() + 60_000).toISOString(),
      };
      const actor = actorFromSession(session);

      expect(actor).not.toBeNull();
      expect(availableTools(actor!)).toEqual(toolRegistry);
    }
  });

  it('does not list a tool when the actor lacks its capability', () => {
    const gatedTool = {
      ...toolRegistry[0],
      capability: 'refund:approve' as Action,
    };

    expect(
      availableTools({ id: 'user_support', role: 'support_agent' }, [
        gatedTool,
      ]),
    ).toEqual([]);
    for (const tool of toolRegistry) {
      expect(can({ id: 'test', role: 'support_agent' }, tool.capability)).toBe(
        true,
      );
    }
  });
});
