export interface ActionStartEvent {
  traceId: string;
  action: string;
  attempt: number;
  input: unknown;
  timestamp: number;
}

export interface ActionSuccessEvent {
  traceId: string;
  action: string;
  attempt: number;
  output: unknown;
  durationMs: number;
  timestamp: number;
}

export interface ActionErrorEvent {
  traceId: string;
  action: string;
  attempts: number;
  errorCode: string;
  errorMessage: string;
  durationMs: number;
  timestamp: number;
}

export interface PolicyBlockedEvent {
  traceId: string;
  action: string;
  reason: string;
  timestamp: number;
}

export interface ExecutionHooks {
  onActionStart?: (event: ActionStartEvent) => void;
  onActionSuccess?: (event: ActionSuccessEvent) => void;
  onActionError?: (event: ActionErrorEvent) => void;
  onPolicyBlocked?: (event: PolicyBlockedEvent) => void;
}
