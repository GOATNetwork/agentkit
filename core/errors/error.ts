import { ErrorCodes, type ErrorCode, type AgentkitError } from './error-codes';

export class AgentkitRuntimeError extends Error implements AgentkitError {
  code: ErrorCode;
  cause?: unknown;

  constructor(code: ErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'AgentkitRuntimeError';
    this.code = code;
    this.cause = cause;
  }
}

export function normalizeError(err: unknown): AgentkitRuntimeError {
  if (err instanceof AgentkitRuntimeError) return err;
  if (err instanceof Error) {
    if (err.message === 'Operation aborted' || err.name === 'AbortError') {
      return new AgentkitRuntimeError(ErrorCodes.ABORTED, err.message, err);
    }
    return new AgentkitRuntimeError(ErrorCodes.INTERNAL_ERROR, err.message, err);
  }
  return new AgentkitRuntimeError(ErrorCodes.INTERNAL_ERROR, 'Unknown runtime error', err);
}
