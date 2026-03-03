export const ErrorCodes = {
  INVALID_INPUT: 'INVALID_INPUT',
  POLICY_BLOCKED: 'POLICY_BLOCKED',
  ACTION_NOT_FOUND: 'ACTION_NOT_FOUND',
  ADAPTER_REQUEST_FAILED: 'ADAPTER_REQUEST_FAILED',
  WALLET_SIGN_FAILED: 'WALLET_SIGN_FAILED',
  WALLET_TRANSFER_FAILED: 'WALLET_TRANSFER_FAILED',
  TIMEOUT: 'TIMEOUT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface AgentkitError {
  code: ErrorCode;
  message: string;
  cause?: unknown;
}
