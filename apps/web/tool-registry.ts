import { can, type Action, type Actor } from '@internal/core';

export type ToolDefinition = {
  id: string;
  name: string;
  route: string;
  capability: Action;
};

export const toolRegistry: readonly ToolDefinition[] = [
  {
    id: 'refunds',
    name: 'Refunds',
    route: '/refunds',
    capability: 'refund:read',
  },
];

export function availableTools(actor: Actor) {
  return toolRegistry.filter((tool) => can(actor, tool.capability));
}
