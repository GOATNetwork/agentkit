import type { ZodTypeAny } from 'zod';

export type RiskLevel = 'read' | 'low' | 'medium' | 'high';

export interface ActionContext {
  traceId: string;
  network: string;
  caller?: string;
  now: number;
  signal?: AbortSignal;
  /** Per-request bearer token for authenticated actions. Not included in hook events or logs. */
  accessToken?: string;
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
  zodOutputSchema?: ZodTypeAny;
  /** Field names to redact from output before passing to execution hooks (e.g. tokens, secrets). */
  sensitiveOutputFields?: string[];
  execute: (ctx: ActionContext, input: TInput) => Promise<TOutput>;
}
