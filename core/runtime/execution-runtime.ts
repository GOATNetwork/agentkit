import type { ActionContext, ActionDefinition, ActionRecovery } from '../schema/action';
import { PolicyEngine } from '../policy/policy-engine';
import { ErrorCodes, type ErrorCode } from '../errors/error-codes';
import { AgentkitRuntimeError, normalizeError } from '../errors/error';
import { formatZodIssues, validateAgainstJsonSchema, validateWithZod } from './schema-validator';
import { isValidTimeout, MAX_TIMEOUT_MS } from './timeout';
import { redactFields } from './redaction';
import { notifyRecovery } from './recovery-observer';
import { consoleLogger, type RuntimeLogger } from './logger';
import { InMemoryIdempotencyStore, type IdempotencyStore } from './idempotency/store';
import { NoopRuntimeMetrics, type RuntimeMetrics } from '../metrics/metrics';
import type { ExecutionHooks } from './execution-hooks';
import { raceSignal, throwIfAborted } from './abort';

/** Error codes that should NOT be retried — they will fail identically on retry. */
const NON_RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set([
  ErrorCodes.INVALID_INPUT,
  ErrorCodes.POLICY_BLOCKED,
  ErrorCodes.ACTION_NOT_FOUND,
  ErrorCodes.ABORTED,
  ErrorCodes.RECOVERY_REQUIRED,
]);

export interface ExecutionOptions {
  confirmed?: boolean;
  idempotencyKey?: string;
  /** Integer milliseconds, 1–2,147,483,647; 0 disables the timeout, omitted uses defaultTimeoutMs. */
  timeoutMs?: number;
  /**
   * Field names listed in `action.sensitiveOutputFields` that should NOT
   * be redacted in onActionSuccess hook events for this single call.
   * Applies to OUTPUT only — there is no input-side equivalent because
   * input hook redaction is non-negotiable for incoming secrets.
   * Undefined or empty array means default behavior (full output
   * redaction). Field names not in sensitiveOutputFields are a no-op.
   * Result.output returned to the caller is never redacted regardless.
   */
  revealedFields?: string[];
}

export interface ExecutionConfig {
  maxRetries: number;
  retryDelayMs: number;
  /** Integer milliseconds, 1–2,147,483,647; 0 or omitted disables the default timeout. */
  defaultTimeoutMs?: number;
  /** If true, high-risk write actions (riskLevel !== 'read') skip automatic retries. Default: true. */
  noRetryHighRiskWrites?: boolean;
  /** If true, validate action output against zodOutputSchema (or outputSchema JSON Schema fallback). Default: true. */
  validateOutput?: boolean;
  logger?: RuntimeLogger;
  metrics?: RuntimeMetrics;
  idempotencyStore?: IdempotencyStore;
  /** Lock/cache TTL, default 3600. Expiry neither cancels execution nor resolves result.settled. */
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
  /** Caller-only payment recovery data; omitted from logs and execution hooks. */
  recovery?: ActionRecovery;
  /**
   * On an interrupted execution, await the underlying action and obtain its final
   * recovery checkpoint. Non-enumerable: never serialized into logs/JSON output.
   * Keep wallet providers alive until this settles if a submission is in flight.
   * Non-cooperative actions can leave this pending indefinitely, even after the lock TTL expires.
   */
  settled?: Promise<ActionRecovery | undefined>;
}

export class ExecutionRuntime {
  private readonly config: ExecutionConfig;

  constructor(
    private readonly policy: PolicyEngine,
    config?: Partial<ExecutionConfig>,
  ) {
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
    inputContext: ActionContext,
    input: TInput,
    options: ExecutionOptions = {},
  ): Promise<ExecutionResult<TOutput>> {
    let recovery: ActionRecovery | undefined;
    // Propagate the runtime idempotency key into the ActionContext so that
    // execute() implementations can read it back. This does not change how
    // the idempotency cache key is computed.
    // Do not invoke an observer getter while copying the context. Its only
    // read belongs inside notifyRecovery's best-effort boundary.
    const contextFields = Reflect.ownKeys(inputContext)
      .filter((key) => key !== 'checkpointRecovery' && Object.prototype.propertyIsEnumerable.call(inputContext, key))
      .map((key) => [key, Reflect.get(inputContext, key)]);
    const context: ActionContext = {
      ...(Object.fromEntries(contextFields) as Omit<ActionContext, 'checkpointRecovery'>),
      // Prefer the runtime option; fall back to whatever the caller may
      // have pre-populated on the context (pre-population is a supported
      // pattern for cross-runtime delegation).
      //
      // Edge: `''` is propagated as-is (?? only short-circuits on
      // null/undefined). Because the cache-key guard below uses a
      // truthy check, an empty-string key disables idempotency caching
      // entirely — that is the existing behavior; callers wanting
      // dedup must pass a non-empty string.
      idempotencyKey: options.idempotencyKey ?? inputContext.idempotencyKey,
      checkpointRecovery: (value) => {
        recovery = structuredClone(value);
        notifyRecovery(inputContext, recovery);
      },
    };
    const captureErrorRecovery = (error: unknown) => {
      if (!(error instanceof AgentkitRuntimeError) || !error.recovery) return;
      const next = structuredClone(error.recovery);
      // Wallet helpers lack action identity. Enrich their hash-based fallback
      // with the latest matching action checkpoint, without aliasing the error.
      if (
        recovery?.kind === 'transaction' &&
        next.kind === 'transaction' &&
        (!recovery.txHash || !next.txHash || recovery.txHash === next.txHash) &&
        (!recovery.signedTxHash || !next.signedTxHash || recovery.signedTxHash === next.signedTxHash)
      ) {
        recovery = { ...recovery, ...next, operationId: recovery.operationId };
      } else recovery = next;
    };
    const traceId = context.traceId;
    const logger = this.config.logger!;
    const metrics = this.config.metrics!;
    const startedAt = Date.now();

    // Reject timer overflow before acquiring a key or starting the action.
    const timeoutMs = options.timeoutMs ?? this.config.defaultTimeoutMs;
    if (timeoutMs !== undefined && timeoutMs !== 0 && !isValidTimeout(timeoutMs)) {
      metrics.incCounter('runtime.error', 1, { action: action.name, code: ErrorCodes.INVALID_INPUT });
      return {
        ok: false,
        errorCode: ErrorCodes.INVALID_INPUT,
        error: `timeoutMs must be 0 (disabled) or an integer between 1 and ${MAX_TIMEOUT_MS}`,
        traceId,
        action: action.name,
        attempts: 0,
      };
    }

    // --- Input validation ---
    const parsedInput = action.zodInputSchema?.safeParse(input);
    const schemaErrors = parsedInput
      ? parsedInput.success
        ? []
        : formatZodIssues(parsedInput.error.issues)
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

    // The runtime owns action validation. Reuse this parse so non-idempotent
    // transforms and refinements run only once per invocation.
    if (parsedInput?.success) input = parsedInput.data as TInput;

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
    const cacheKey =
      options.idempotencyKey && action.idempotencyMode !== 'action'
        ? `${action.name}:${options.idempotencyKey}`
        : undefined;
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
          error: `Key is reserved by an executing or unreconciled operation: ${options.idempotencyKey}`,
          traceId,
          action: action.name,
          attempts: 0,
        };
      }
      lockToken = token;
    }

    // --- Determine effective max retries ---
    const isHighRiskWrite = action.riskLevel !== 'read' && this.config.noRetryHighRiskWrites;
    const effectiveMaxRetries = isHighRiskWrite || action.retryable === false ? 0 : this.config.maxRetries;

    let attempt = 0;
    let lastErr: unknown;

    let executionSettled: Promise<void> | undefined;
    let executionPending = false;
    let success: { output: TOutput } | undefined;
    const completedResult = (): ExecutionResult<TOutput> | undefined =>
      success ? { ok: true, output: success.output, traceId, action: action.name, attempts: attempt } : undefined;
    // Only an error returned to the caller makes a later success an interrupted one.
    let afterInterruption = false;
    while (attempt <= effectiveMaxRetries) {
      attempt += 1;
      const controller = new AbortController();
      try {
        logger.log('info', 'action run start', { traceId, action: action.name, attempt });
        this.config.hooks?.onActionStart?.({
          traceId,
          action: action.name,
          attempt,
          input: action.sensitiveInputFields?.length ? redactFields(input, action.sensitiveInputFields) : input,
          timestamp: Date.now(),
        });
        const mergedSignal =
          timeoutMs && context.signal
            ? AbortSignal.any([controller.signal, context.signal])
            : timeoutMs
              ? controller.signal
              : context.signal;
        const ctxWithSignal = mergedSignal ? { ...context, signal: mergedSignal } : context;
        executionPending = true;
        // Validation and caching belong to the execution, even if its caller
        // stops waiting. Keep the key locked until this promise settles.
        const execution = Promise.resolve()
          .then(async () => {
            throwIfAborted(ctxWithSignal.signal);
            const output = await action.execute(ctxWithSignal, input);
            if (this.config.validateOutput) {
              const outputErrors = action.zodOutputSchema
                ? validateWithZod(action.zodOutputSchema, output)
                : action.outputSchema
                  ? validateAgainstJsonSchema(action.outputSchema as any, output)
                  : [];
              if (outputErrors.length) {
                throw new AgentkitRuntimeError(
                  ErrorCodes.INVALID_OUTPUT,
                  `Output schema validation failed: ${outputErrors.join('; ')}`,
                );
              }
            }
            if (cacheKey) {
              await this.config.idempotencyStore!.complete(
                cacheKey,
                output,
                this.config.idempotencyTtlSeconds,
                lockToken,
              );
            }
            logger.log('info', 'action run success', {
              traceId,
              action: action.name,
              attempt,
              ...(afterInterruption ? { afterInterruption: true } : {}),
            });
            const effectiveSensitiveOutputFields = action.sensitiveOutputFields?.length
              ? options.revealedFields?.length
                ? action.sensitiveOutputFields.filter((f) => !options.revealedFields!.includes(f))
                : action.sensitiveOutputFields
              : undefined;
            this.config.hooks?.onActionSuccess?.({
              traceId,
              action: action.name,
              attempt,
              output: effectiveSensitiveOutputFields?.length
                ? redactFields(output, effectiveSensitiveOutputFields)
                : output,
              durationMs: Date.now() - startedAt,
              timestamp: Date.now(),
              ...(afterInterruption ? { afterInterruption: true } : {}),
            });
            metrics.incCounter('runtime.success', 1, { action: action.name });
            if (afterInterruption) metrics.incCounter('runtime.late_success', 1, { action: action.name });
            metrics.observe('runtime.latency_ms', Date.now() - startedAt, { action: action.name });
            success = { output };
            return output;
          })
          .finally(() => {
            executionPending = false;
          });
        executionSettled = execution.then(
          () => {},
          (error) => {
            captureErrorRecovery(error);
          },
        );
        const abortable = raceSignal(execution, context.signal);
        const output = timeoutMs
          ? await this.withTimeout(abortable, timeoutMs, action.name, controller)
          : await abortable;

        return {
          ok: true,
          output,
          traceId,
          action: action.name,
          attempts: attempt,
        };
      } catch (err) {
        controller.abort();
        // A timer can win the promise race after execution has already validated
        // and reported success. This applies even when retries are disabled.
        const completed = completedResult();
        if (completed) return completed;
        captureErrorRecovery(err);
        const norm = context.signal?.aborted
          ? new AgentkitRuntimeError(ErrorCodes.ABORTED, 'Operation aborted by caller', err)
          : normalizeError(err);
        const interrupted = norm.code === ErrorCodes.ABORTED || norm.code === ErrorCodes.TIMEOUT;
        lastErr = norm;
        logger.log('warn', interrupted ? 'action wait interrupted' : 'action run failed', {
          traceId,
          action: action.name,
          attempt,
          errorCode: norm.code,
          error: norm.message,
        });

        // Non-retryable errors: break immediately
        if (NON_RETRYABLE_CODES.has(norm.code) || recovery) break;

        if (attempt > effectiveMaxRetries) break;
        // Exponential backoff: delay * 2^(attempt-1)
        await new Promise((r) => setTimeout(r, this.config.retryDelayMs * Math.pow(2, attempt - 1)));
        // Let cooperative cancellation settle during the bounded backoff. The
        // timeout catch can run before the execution's promise cleanup, so its
        // synchronous pending flag is not a retry decision. Never overlap an
        // unfinished attempt or repeat an attempt that completed successfully.
        const completedAfterBackoff = completedResult();
        if (completedAfterBackoff) {
          // The bounded retry wait observed an actual validated success. Its
          // hook, metric and cache write already ran; return that outcome once.
          return completedAfterBackoff;
        }
        if (executionPending || recovery) break;
        if (context.signal?.aborted) {
          lastErr = new AgentkitRuntimeError(ErrorCodes.ABORTED, 'Operation aborted by caller');
          break;
        }
      }
    }

    // An abort/timeout only stops the caller waiting. Release after actual
    // settlement; token-aware release leaves a completed cache entry intact.
    // A failed execution with recovery evidence is NOT a safe-to-retry failure:
    // retain its reservation under the store's existing TTL contract.
    if (cacheKey && lockToken) {
      const release = async () => {
        if (recovery) return;
        try {
          await this.config.idempotencyStore!.release(cacheKey, lockToken);
        } catch (releaseErr) {
          logger.log('warn', 'failed to release idempotency lock', { traceId, cacheKey, error: String(releaseErr) });
        }
      };
      if (executionSettled) executionSettled = executionSettled.then(release);
      else await release();
      if (!executionPending) await executionSettled;
    }

    // Settlement may also have completed during asynchronous lock cleanup.
    const completed = completedResult();
    if (completed) return completed;
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
    const result: ExecutionResult<TOutput> = {
      ok: false,
      errorCode: norm.code,
      error: norm.message,
      traceId,
      action: action.name,
      attempts: attempt,
      ...(recovery ? { recovery } : {}),
    };
    if (executionSettled)
      Object.defineProperty(result, 'settled', {
        value: executionSettled.then(() => (recovery ? structuredClone(recovery) : undefined)),
        enumerable: false,
      });
    afterInterruption = norm.code === ErrorCodes.ABORTED || norm.code === ErrorCodes.TIMEOUT;
    return result;
  }

  private withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    actionName: string,
    controller: AbortController,
  ): Promise<T> {
    // Capture the timer so we can clear it when `promise` wins the race.
    // Without clearTimeout the timer keeps firing after success, calling
    // `controller.abort()` on an already-completed attempt and producing
    // a stale `reject()` on the abandoned inner promise. `.unref()` only
    // saves us from blocking Node's event-loop exit; non-Node runtimes
    // (Bun/Deno/test runners) and long-lived workers still leak the timer.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new AgentkitRuntimeError(ErrorCodes.TIMEOUT, `Action ${actionName} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      if (typeof timer === 'object' && 'unref' in (timer as object)) (timer as { unref(): void }).unref();
    });
    const settled = promise.finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
    return Promise.race([settled, timeoutPromise]);
  }
}
