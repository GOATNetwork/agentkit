import type { ZodTypeAny } from 'zod';

export type RiskLevel = 'read' | 'low' | 'medium' | 'high';

export interface ActionContext {
  traceId: string;
  network: string;
  caller?: string;
  now: number;
}

export interface ActionDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  riskLevel: RiskLevel;
  requiresConfirmation: boolean;
  networks: string[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  zodInputSchema?: ZodTypeAny;
  execute: (ctx: ActionContext, input: TInput) => Promise<TOutput>;
}
