import { can, type Action, type Actor } from '@internal/core';

export type ToolDefinition = {
  id: string;
  name: string;
  description: string;
  route: string;
  capability: Action;
};

export const toolRegistry: readonly ToolDefinition[] = [
  {
    id: 'refunds',
    name: 'Refunds',
    description: 'Review and raise customer refund requests.',
    route: '/refunds',
    capability: 'refund:read',
  },
  {
    id: 'kyc',
    name: 'KYC review',
    description: 'Review customer identity verification cases.',
    route: '/kyc',
    capability: 'kyc:read',
  },
];

export function availableTools(
  actor: Actor,
  registry: readonly ToolDefinition[] = toolRegistry,
) {
  return registry.filter((tool) => can(actor, tool.capability));
}
