import type { ActionContext, ActionDefinition } from '../schema/action';
import { PolicyEngine } from '../policy/policy-engine';
import { ErrorCodes, type ErrorCode } from '../errors/error-codes';
import { AgentkitRuntimeError, normalizeError } from '../errors/error';
import { validateAgainstJsonSchema, validateWithZod } from './schema-validator';
import { consoleLogger, type RuntimeLogger } from './logger';
import { InMemoryIdempotencyStore, type IdempotencyStore } from './idempotency/store';
import { NoopRuntimeMetrics, type RuntimeMetrics } from '../metrics/metrics';
import type { ExecutionHooks } from './execution-hooks';

/** Replace values of named fields with '[REDACTED]' in a shallow copy. */
function redactFields(obj: unknown, fields: readonly string[]): unknown {
  if (obj == null || typeof obj !== 'object' || !fields.length) return obj;
  const copy = { ...(obj as Record<string, unknown>) };
  for (const f of fields) {
    if (f in copy) copy[f] = '[REDACTED]';
  }
  return copy;
}

/** Error codes that should NOT be retried — they will fail identically on retry. */
const NON_RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set([
  ErrorCodes.INVALID_INPUT,
  ErrorCodes.POLICY_BLOCKED,
  ErrorCodes.ACTION_NOT_FOUND,
  ErrorCodes.ABORTED,
]);

export interface ExecutionOptions {
  confirmed?: boolean;
  idempotencyKey?: string;
  timeoutMs?: number;
}

export interface ExecutionConfig {
  maxRetries: number;
  retryDelayMs: number;
  defaultTimeoutMs?: number;
  /** If true, high-risk write actions (riskLevel !== 'read') skip automatic retries. Default: true. */
  noRetryHighRiskWrites?: boolean;
  /** If true, validate action output against zodOutputSchema (or outputSchema JSON Schema fallback). Default: true. */
  validateOutput?: boolean;
  logger?: RuntimeLogger;
  metrics?: RuntimeMetrics;
  idempotencyStore?: IdempotencyStore;
  idempotencyTtlSeconds?: number;
  hooks?: ExecutionHooks;
}

export interface ExecutionResult<T = unknown> {
  ok: boolean;
  output?: T;
  error?: string;
  errorCode?: ErrorCode;
  traceId: string;
  action: string;
  attempts: number;
}

export class ExecutionRuntime {
  private readonly config: ExecutionConfig;

  constructor(private readonly policy: PolicyEngine, config?: Partial<ExecutionConfig>) {
    this.config = {
      maxRetries: config?.maxRetries ?? 2,
      retryDelayMs: config?.retryDelayMs ?? 200,
      defaultTimeoutMs: config?.defaultTimeoutMs,
      noRetryHighRiskWrites: config?.noRetryHighRiskWrites ?? true,
      validateOutput: config?.validateOutput ?? true,
      logger: config?.logger ?? consoleLogger,
      metrics: config?.metrics ?? new NoopRuntimeMetrics(),
      idempotencyStore: config?.idempotencyStore ?? new InMemoryIdempotencyStore(),
      idempotencyTtlSeconds: config?.idempotencyTtlSeconds ?? 3600,
      hooks: config?.hooks,
    };
  }

  async run<TInput, TOutput>(
    action: ActionDefinition<TInput, TOutput>,
    context: ActionContext,
    input: TInput,
    options: ExecutionOptions = {}
  ): Promise<ExecutionResult<TOutput>> {
    const traceId = context.traceId;
    const logger = this.config.logger!;
    const metrics = this.config.metrics!;
    const startedAt = Date.now();

    // --- Input validation ---
    const schemaErrors = action.zodInputSchema
      ? validateWithZod(action.zodInputSchema, input)
      : action.inputSchema
      ? validateAgainstJsonSchema(action.inputSchema as any, input)
      : [];

    if (schemaErrors.length) {
      metrics.incCounter('runtime.error', 1, { action: action.name, code: ErrorCodes.INVALID_INPUT });
      return {
        ok: false,
        errorCode: ErrorCodes.INVALID_INPUT,
        error: `Schema validation failed: ${schemaErrors.join('; ')}`,
        traceId,
        action: action.name,
        attempts: 0,
      };
    }

    // --- Policy evaluation (includes action.networks check) ---
    const decision = this.policy.evaluate({
      action: action as ActionDefinition,
      context,
      payload: input,
      confirmed: options.confirmed,
    });

    if (!decision.allowed) {
      this.config.hooks?.onPolicyBlocked?.({
        traceId,
        action: action.name,
        reason: decision.reason ?? 'unknown',
        timestamp: Date.now(),
      });
      metrics.incCounter('runtime.error', 1, { action: action.name, code: ErrorCodes.POLICY_BLOCKED });
      return {
        ok: false,
        errorCode: ErrorCodes.POLICY_BLOCKED,
        error: `Policy blocked: ${decision.reason}`,
        traceId,
        action: action.name,
        attempts: 0,
      };
    }

    // --- Idempotency: atomic acquire ---
    const cacheKey = options.idempotencyKey ? `${action.name}:${options.idempotencyKey}` : undefined;
    let lockToken: string | undefined;
    if (cacheKey) {
      const cached = await this.config.idempotencyStore!.get<TOutput>(cacheKey);
      if (cached !== null) {
        logger.log('info', 'idempotency hit', { traceId, action: action.name, cacheKey });
        metrics.incCounter('runtime.idempotency_hit', 1, { action: action.name });
        return {
          ok: true,
          output: cached.value,
          traceId,
          action: action.name,
          attempts: 0,
        };
      }

      const token = await this.config.idempotencyStore!.acquire(cacheKey, this.config.idempotencyTtlSeconds);
      if (token === null) {
        // Another execution is in progress for this key
        return {
          ok: false,
          errorCode: ErrorCodes.IDEMPOTENCY_CONFLICT,
          error: `Another execution is in progress for key: ${options.idempotencyKey}`,
          traceId,
          action: action.name,
          attempts: 0,
        };
      }
      lockToken = token;
    }

    // --- Determine effective max retries ---
    const isHighRiskWrite = action.riskLevel !== 'read' && this.config.noRetryHighRiskWrites;
    const effectiveMaxRetries = isHighRiskWrite ? 0 : this.config.maxRetries;

    let attempt = 0;
    let lastErr: unknown;

    while (attempt <= effectiveMaxRetries) {
      attempt += 1;
      const controller = new AbortController();
      try {
        logger.log('info', 'action run start', { traceId, action: action.name, attempt });
        this.config.hooks?.onActionStart?.({
          traceId,
          action: action.name,
          attempt,
          input,
          timestamp: Date.now(),
        });
        const timeoutMs = options.timeoutMs ?? this.config.defaultTimeoutMs;
        const mergedSignal = timeoutMs && context.signal
          ? AbortSignal.any([controller.signal, context.signal])
          : timeoutMs ? controller.signal : context.signal;
        const ctxWithSignal = mergedSignal ? { ...context, signal: mergedSignal } : context;
        const output = timeoutMs
          ? await this.withTimeout(action.execute(ctxWithSignal, input), timeoutMs, action.name, controller)
          : await action.execute(ctxWithSignal, input);

        // --- Output validation (M-02) ---
        if (this.config.validateOutput) {
          const outputErrors = action.zodOutputSchema
            ? validateWithZod(action.zodOutputSchema, output)
            : action.outputSchema
            ? validateAgainstJsonSchema(action.outputSchema as any, output)
            : [];
          if (outputErrors.length) {
            throw new AgentkitRuntimeError(
              ErrorCodes.INVALID_OUTPUT,
              `Output schema validation failed: ${outputErrors.join('; ')}`
            );
          }
        }

        if (cacheKey) {
          await this.config.idempotencyStore!.complete(
            cacheKey,
            output,
            this.config.idempotencyTtlSeconds
          );
        }
        logger.log('info', 'action run success', { traceId, action: action.name, attempt });
        this.config.hooks?.onActionSuccess?.({
          traceId,
          action: action.name,
          attempt,
          output: action.sensitiveOutputFields?.length
            ? redactFields(output, action.sensitiveOutputFields)
            : output,
          durationMs: Date.now() - startedAt,
          timestamp: Date.now(),
        });
        metrics.incCounter('runtime.success', 1, { action: action.name });
        metrics.observe('runtime.latency_ms', Date.now() - startedAt, { action: action.name });
        return {
          ok: true,
          output,
          traceId,
          action: action.name,
          attempts: attempt,
        };
      } catch (err) {
        controller.abort();
        const norm = context.signal?.aborted
          ? new AgentkitRuntimeError(ErrorCodes.ABORTED, 'Operation aborted by caller', err)
          : normalizeError(err);
        lastErr = norm;
        logger.log('warn', 'action run failed', {
          traceId,
          action: action.name,
          attempt,
          errorCode: norm.code,
          error: norm.message,
        });

        // Non-retryable errors: break immediately
        if (NON_RETRYABLE_CODES.has(norm.code)) break;

        if (attempt > effectiveMaxRetries) break;
        // Exponential backoff: delay * 2^(attempt-1)
        await new Promise((r) => setTimeout(r, this.config.retryDelayMs * Math.pow(2, attempt - 1)));
      }
    }

    // Release idempotency lock so future retries with same key can proceed
    if (cacheKey && lockToken) {
      try {
        await this.config.idempotencyStore!.release(cacheKey, lockToken);
      } catch (releaseErr) {
        logger.log('warn', 'failed to release idempotency lock', { traceId, cacheKey, error: String(releaseErr) });
      }
    }

    const norm = normalizeError(lastErr);
    this.config.hooks?.onActionError?.({
      traceId,
      action: action.name,
      attempts: attempt,
      errorCode: norm.code,
      errorMessage: norm.message,
      durationMs: Date.now() - startedAt,
      timestamp: Date.now(),
    });
    metrics.incCounter('runtime.error', 1, { action: action.name, code: norm.code });
    metrics.observe('runtime.latency_ms', Date.now() - startedAt, { action: action.name });
    return {
      ok: false,
      errorCode: norm.code,
      error: norm.message,
      traceId,
      action: action.name,
      attempts: attempt,
    };
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, actionName: string, controller: AbortController): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => {
          controller.abort();
          reject(new AgentkitRuntimeError(ErrorCodes.TIMEOUT, `Action ${actionName} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        // Don't prevent process exit
        if (typeof timer === 'object' && 'unref' in timer) timer.unref();
      }),
    ]);
  }
}
