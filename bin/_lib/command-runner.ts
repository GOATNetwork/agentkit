/**
 * Shared CLI plumbing for the agentkit-gns / agentkit-giftcard binaries.
 *
 * Responsibilities:
 *   - load dotenv-style env from cwd (best effort; no hard dependency on dotenv).
 *   - build a one-action `ActionProvider` + `PolicyEngine` + `ExecutionRuntime`.
 *   - run a single action with a generated traceId and the caller's input.
 *   - map `ExecutionResult.errorCode` to a process exit code per the table:
 *
 *       0  — success
 *       1  — user-input error           (INVALID_INPUT and commander parse errors)
 *       4  — POLICY_BLOCKED
 *       5  — chain mismatch / expiry / order-state error (heuristic: INVALID_INPUT
 *            with a known marker substring; otherwise stays in bucket 1)
 *       10 — ADAPTER_REQUEST_FAILED
 *       99 — any other / unknown error
 *
 * The wrapper is intentionally synchronous in shape: a subcommand calls
 * `runCommand(actionFactory, opts)` and the wrapper handles everything
 * from runtime construction through process exit code.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { ActionProvider } from '../../providers/action-provider';
import { PolicyEngine, type PolicyConfig } from '../../core/policy/policy-engine';
import { ExecutionRuntime } from '../../core/runtime/execution-runtime';
import {
  type ExecutionOptions,
  type ExecutionResult,
} from '../../core/runtime/execution-runtime';
import { ErrorCodes, type ErrorCode } from '../../core/errors/error-codes';
import type { RuntimeLogger } from '../../core/runtime/logger';
import type { ActionDefinition, ActionContext } from '../../core/schema/action';
import { emit, status, type OutputFormat } from './output';
import { ConfirmationRequiredError } from './confirmations';

/** Exit codes per the Phase G spec. */
export const ExitCodes = {
  SUCCESS: 0,
  USER_INPUT: 1,
  POLICY_BLOCKED: 4,
  CHAIN_OR_STATE: 5,
  ADAPTER: 10,
  UNKNOWN: 99,
} as const;

export type ExitCode = (typeof ExitCodes)[keyof typeof ExitCodes];

/** Markers that pivot an `INVALID_INPUT` from bucket 1 → bucket 5. */
const CHAIN_OR_STATE_MARKERS = [
  'chain_mismatch',
  'order_not_payable',
  'order_invalid',
  'commit expired',
  'commit not yet ready',
  'commit not recorded',
  'commit context mismatch',
  'insufficient allowance',
  'expire_at',
  'CommitmentTooNew',
];

/** Heuristic markers that re-classify INTERNAL_ERROR → bucket 10 (upstream adapter).
 *  fetch() throws plain `TypeError('fetch failed')` on network-level failures
 *  (ECONNREFUSED, DNS, unreachable host) — the runtime normalizes these to
 *  INTERNAL_ERROR, but for the operator they're "upstream HTTP didn't reach". */
const ADAPTER_MARKERS = [
  'fetch failed',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ETIMEDOUT',
  'socket hang up',
];

export function classifyExitCode(errorCode: ErrorCode | undefined, message: string | undefined): ExitCode {
  if (!errorCode) return ExitCodes.UNKNOWN;
  if (errorCode === ErrorCodes.POLICY_BLOCKED) return ExitCodes.POLICY_BLOCKED;
  if (errorCode === ErrorCodes.ADAPTER_REQUEST_FAILED) return ExitCodes.ADAPTER;
  if (errorCode === ErrorCodes.INVALID_INPUT) {
    const m = message ?? '';
    for (const marker of CHAIN_OR_STATE_MARKERS) {
      if (m.toLowerCase().includes(marker.toLowerCase())) return ExitCodes.CHAIN_OR_STATE;
    }
    return ExitCodes.USER_INPUT;
  }
  if (errorCode === ErrorCodes.INTERNAL_ERROR) {
    const m = (message ?? '').toLowerCase();
    for (const marker of ADAPTER_MARKERS) {
      if (m.includes(marker.toLowerCase())) return ExitCodes.ADAPTER;
    }
    return ExitCodes.UNKNOWN;
  }
  // INVALID_OUTPUT, TIMEOUT, ABORTED, etc.
  return ExitCodes.UNKNOWN;
}

/** Best-effort dotenv-style load: parses KEY=VALUE lines from a `.env` walk-up. */
export function loadEnvFromCwd(): void {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    const file = resolve(dir, '.env');
    if (existsSync(file)) {
      try {
        const body = readFileSync(file, 'utf8');
        for (const rawLine of body.split(/\r?\n/)) {
          const line = rawLine.trim();
          if (!line || line.startsWith('#')) continue;
          const eq = line.indexOf('=');
          if (eq < 0) continue;
          const key = line.slice(0, eq).trim();
          let value = line.slice(eq + 1).trim();
          if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
          if (!(key in process.env)) process.env[key] = value;
        }
      } catch {
        // best-effort; ignore parse errors
      }
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

export interface RunCommandOptions {
  /** Concrete network context (passed to `ActionContext.network` AND the policy allowlist). */
  network: string;
  /** Additional networks the policy should permit (besides `network`). Useful for cross-chain. */
  extraAllowedNetworks?: string[];
  /** Input payload for the action. */
  input: unknown;
  /** Runtime execution options. */
  executionOptions?: ExecutionOptions;
  /** Output format. */
  format: OutputFormat;
  /** Pre-built helper actions to register alongside the primary action (e.g. print-secret). */
  extraActions?: ActionDefinition[];
  /** Override the policy `maxRiskWithoutConfirm`. Default `'low'`. */
  maxRiskWithoutConfirm?: PolicyConfig['maxRiskWithoutConfirm'];
  /** Override `writeEnabled`. Default `true`. */
  writeEnabled?: boolean;
  /** Subcommand label for logs (only used in human mode). */
  label?: string;
}

export interface RunCommandResult<T = unknown> {
  result: ExecutionResult<T>;
  exitCode: ExitCode;
}

/** Build runtime + run a single action. Does NOT call `process.exit`; returns the exit code. */
export async function runAction<TInput, TOutput>(
  action: ActionDefinition<TInput, TOutput>,
  opts: RunCommandOptions,
): Promise<RunCommandResult<TOutput>> {
  const provider = new ActionProvider();
  provider.register(action);
  for (const extra of opts.extraActions ?? []) provider.register(extra);

  const allowedNetworks = Array.from(new Set([opts.network, ...(opts.extraAllowedNetworks ?? [])]));
  const policy = new PolicyEngine({
    allowedNetworks,
    maxRiskWithoutConfirm: opts.maxRiskWithoutConfirm ?? 'low',
    writeEnabled: opts.writeEnabled ?? true,
  });
  // Route runtime logs to STDERR so --json stdout stays one parseable JSON.
  const stderrLogger: RuntimeLogger = {
    log(level, message, meta) {
      const payload = { ts: new Date().toISOString(), level, message, ...meta };
      process.stderr.write(JSON.stringify(payload) + '\n');
    },
  };
  const runtime = new ExecutionRuntime(policy, {
    maxRetries: 0,
    retryDelayMs: 200,
    logger: stderrLogger,
  });

  const ctx: ActionContext = {
    traceId: `cli_${randomUUID()}`,
    network: opts.network,
    now: Date.now(),
  };

  const result = (await runtime.run(
    action,
    ctx,
    opts.input as TInput,
    opts.executionOptions ?? {},
  )) as ExecutionResult<TOutput>;

  const exitCode = result.ok
    ? ExitCodes.SUCCESS
    : classifyExitCode(result.errorCode, result.error);

  return { result, exitCode };
}

/** Print the result and return the exit code. */
export function reportResult(result: ExecutionResult<unknown>, format: OutputFormat): void {
  if (format === 'json') {
    emit(result, format);
    return;
  }
  if (result.ok) {
    status('ok', `${result.action} (trace=${result.traceId}, attempts=${result.attempts})`);
    if (result.output !== undefined) emit(result.output, 'human');
    return;
  }
  status('error', `${result.action} failed: ${result.errorCode ?? 'UNKNOWN'} — ${result.error ?? 'no message'}`);
}

/** Markers that pivot a thrown Error → exit 1 (USER_INPUT). */
const USER_INPUT_ERROR_MARKERS = [
  'invalid --',          // our option-parser throws
  'unknown option',
  'unknown command',
  'missing required',
  'expects key=value',
];

/** Translate caught errors (from CLI plumbing, not actions) into an exit code + report. */
export function handleCaughtError(err: unknown, format: OutputFormat): ExitCode {
  if (err instanceof ConfirmationRequiredError) {
    if (format === 'json') {
      emit({ ok: false, error: err.message, errorCode: 'CONFIRMATION_REQUIRED' }, format);
    } else {
      status('error', err.message);
    }
    return ExitCodes.USER_INPUT;
  }
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  let code: ExitCode = ExitCodes.UNKNOWN;
  for (const marker of USER_INPUT_ERROR_MARKERS) {
    if (lower.includes(marker)) {
      code = ExitCodes.USER_INPUT;
      break;
    }
  }
  if (format === 'json') {
    emit({ ok: false, error: message, errorCode: code === ExitCodes.USER_INPUT ? 'INVALID_INPUT' : 'UNKNOWN' }, format);
  } else {
    status('error', message);
  }
  return code;
}
