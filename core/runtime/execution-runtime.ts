import type { ActionContext, ActionDefinition } from '../schema/action';
import { PolicyEngine } from '../policy/policy-engine';
import { ErrorCodes, type ErrorCode } from '../errors/error-codes';
import { AgentkitRuntimeError, normalizeError } from '../errors/error';
import { validateAgainstJsonSchema, validateWithZod } from './schema-validator';
import { consoleLogger, type RuntimeLogger } from './logger';
import { InMemoryIdempotencyStore, type IdempotencyStore } from './idempotency/store';
import { NoopRuntimeMetrics, type RuntimeMetrics } from '../metrics/metrics';
import type { ExecutionHooks } from './execution-hooks';

export interface ExecutionOptions {
  confirmed?: boolean;
  idempotencyKey?: string;
  timeoutMs?: number;
}

export interface ExecutionConfig {
  maxRetries: number;
  retryDelayMs: number;
  defaultTimeoutMs?: number;
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

    const cacheKey = options.idempotencyKey ? `${action.name}:${options.idempotencyKey}` : undefined;
    if (cacheKey) {
      const cached = await this.config.idempotencyStore!.get<TOutput>(cacheKey);
      if (cached) {
        logger.log('info', 'idempotency hit', { traceId, action: action.name, cacheKey });
        metrics.incCounter('runtime.idempotency_hit', 1, { action: action.name });
        return {
          ok: true,
          output: cached,
          traceId,
          action: action.name,
          attempts: 0,
        };
      }
    }

    let attempt = 0;
    let lastErr: unknown;

    while (attempt <= this.config.maxRetries) {
      attempt += 1;
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
        const output = timeoutMs
          ? await this.withTimeout(action.execute(context, input), timeoutMs, action.name)
          : await action.execute(context, input);
        if (cacheKey) {
          await this.config.idempotencyStore!.set(
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
          output,
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
        lastErr = err;
        const norm = normalizeError(err);
        logger.log('warn', 'action run failed', {
          traceId,
          action: action.name,
          attempt,
          errorCode: norm.code,
          error: norm.message,
        });

        if (attempt > this.config.maxRetries) break;
        await new Promise((r) => setTimeout(r, this.config.retryDelayMs * attempt));
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

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, actionName: string): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new AgentkitRuntimeError(ErrorCodes.TIMEOUT, `Action ${actionName} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  }
}
