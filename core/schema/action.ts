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
  /**
   * Runtime idempotency key, populated by ExecutionRuntime from
   * ExecutionOptions.idempotencyKey before execute() is invoked.
   * Actions that accept their own idempotency_key input field can compare
   * to this value to enforce a single-source-of-truth contract.
   */
  idempotencyKey?: string;
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
  /**
   * Top-level field names to redact from output before passing to
   * execution hooks (e.g. tokens, secrets). SHALLOW redaction only —
   * nested objects are not traversed; keep secret fields at the top
   * level of your output shape.
   */
  sensitiveOutputFields?: string[];
  /**
   * Top-level field names whose values must be redacted before being
   * passed to onActionStart hook events. Symmetric to
   * sensitiveOutputFields. Use for secrets that arrive via input
   * (e.g., commit secret being chained into a register call).
   *
   * SHALLOW redaction only — nested objects are not traversed.
   * Convention: keep sensitive inputs at the top level of TInput
   * rather than nesting them inside a context-style object, otherwise
   * the redaction will not reach them.
   */
  sensitiveInputFields?: string[];
  execute: (ctx: ActionContext, input: TInput) => Promise<TOutput>;
}
