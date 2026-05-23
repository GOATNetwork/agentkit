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
   * Field names to redact from output before passing to execution hooks
   * (e.g. tokens, secrets). Redaction is shallow with one extension:
   * arrays of records at the top level are walked one hop, so a name
   * like `'card_code'` reaches both `output.card_code` and
   * `output.orders[i].card_code`. Nested objects (e.g.
   * `output.card.card_code`) are NOT reached — keep secret fields at the
   * top level of the record they live in.
   */
  sensitiveOutputFields?: string[];
  /**
   * Field names whose values must be redacted before being passed to
   * onActionStart hook events. Symmetric to sensitiveOutputFields and
   * subject to the same shallow-with-array-hop rule. Use for secrets
   * that arrive via input (e.g., commit secret chained into register).
   *
   * Convention: keep sensitive inputs at the top level of TInput rather
   * than nesting them, otherwise redaction will not reach them.
   */
  sensitiveInputFields?: string[];
  execute: (ctx: ActionContext, input: TInput) => Promise<TOutput>;
}
