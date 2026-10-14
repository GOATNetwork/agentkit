import type { ZodTypeAny } from 'zod';

export type RiskLevel = 'read' | 'recovery' | 'low' | 'medium' | 'high';

/** JSON-serializable recovery handle returned to the caller, never to hooks/logs. */
export interface ActionRecovery {
  kind: string;
  operationId: string;
  phase: string;
  [key: string]: unknown;
}

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
  /**
   * Observe detached recovery snapshots before/after a side effect. Runtime and
   * built-in actions isolate synchronous throws and async rejections and do not
   * await observers. Use the payment recovery store for durable persistence.
   */
  checkpointRecovery?: (recovery: ActionRecovery) => void;
}

export interface ActionDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  riskLevel: RiskLevel;
  requiresConfirmation: boolean;
  /** Set false for operations whose ambiguous result must be reconciled rather than replayed. */
  retryable?: boolean;
  /** Actions with an atomic durable journal must validate every call themselves, including cached intents. */
  idempotencyMode?: 'runtime' | 'action';
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
  /** Low-level callback receiving parsed input. Invoke actions through ExecutionRuntime for validation and policy. */
  execute: (ctx: ActionContext, input: TInput) => Promise<TOutput>;
}
