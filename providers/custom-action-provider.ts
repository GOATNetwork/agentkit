import type { ZodTypeAny } from 'zod';
import type { ActionDefinition, RiskLevel } from '../core/schema/action';
import { ActionProvider } from './action-provider';

export interface CustomActionInput<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  schema: ZodTypeAny;
  invoke: (input: TInput) => Promise<TOutput>;
  riskLevel?: RiskLevel;
  networks?: string[];
  requiresConfirmation?: boolean;
}

export function customActionProvider(actions: CustomActionInput[]): ActionProvider {
  const provider = new ActionProvider();
  for (const def of actions) {
    const action: ActionDefinition = {
      name: def.name,
      description: def.description,
      riskLevel: def.riskLevel ?? 'low',
      requiresConfirmation: def.requiresConfirmation ?? false,
      networks: def.networks ?? [],
      zodInputSchema: def.schema,
      async execute(_ctx, input) {
        return def.invoke(input);
      },
    };
    provider.register(action);
  }
  return provider;
}
