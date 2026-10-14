import { AgentkitRuntimeError } from '../../core/errors/error';
import { ErrorCodes } from '../../core/errors/error-codes';
import { throwIfAborted } from '../../core/runtime/abort';
import { isValidTimeout } from '../../core/runtime/timeout';
import { deriveTarget } from 'goatflow-paykit';
export { throwIfAborted } from '../../core/runtime/abort';

export { evmAddressPattern, txHashPattern } from '../../core/schema/validators';
export const sessionStates = [
  'CREATED',
  'ORDER_CREATED',
  'PAYMENT_CONFIRMED',
  'EXPIRED',
  'FAILED',
  'CANCELLED',
] as const;

export function invalid(message: string): never {
  throw new AgentkitRuntimeError(ErrorCodes.INVALID_INPUT, message);
}

export function invalidResponse(message: string): never {
  throw new AgentkitRuntimeError(ErrorCodes.ADAPTER_REQUEST_FAILED, message);
}

export function paymentTarget(url: string) {
  try {
    return deriveTarget(url);
  } catch (cause) {
    throw new AgentkitRuntimeError(
      ErrorCodes.INVALID_INPUT,
      'Invalid PayKit link; use a merchant PayKit URL or manifest URL',
      cause,
    );
  }
}

export function trustedPaymentUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid('Invalid payment URL');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) {
    return invalid('Payment URLs require HTTPS (HTTP is allowed only on loopback), without credentials');
  }
  return url;
}

export function trustedOrigin(value: string): string {
  return trustedPaymentUrl(value).origin;
}

export function pathSegment(value: string): string {
  if (!value?.trim() || value === '.' || value === '..') invalid('Invalid resource identifier');
  return encodeURIComponent(value);
}

export async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new AgentkitRuntimeError(ErrorCodes.ABORTED, 'Operation aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

interface RequestSignals {
  combined: AbortSignal;
  deadline: AbortSignal;
}
// Keep the transport's deadline available for body reads without replacing the
// Response or depending on a platform-specific DOMException name.
const responseSignals = new WeakMap<Response, RequestSignals>();

/** Classified transport failure; write boundaries add rail-specific recovery guidance. */
export class PaymentRequestError extends AgentkitRuntimeError {}

function requestFailure(
  cause: unknown,
  signals?: RequestSignals,
  status?: number,
  invalidJson = false,
): AgentkitRuntimeError {
  if (signals?.combined.aborted) {
    const timedOut = signals.deadline.aborted && signals.combined.reason === signals.deadline.reason;
    return new PaymentRequestError(
      timedOut ? ErrorCodes.ADAPTER_REQUEST_FAILED : ErrorCodes.ABORTED,
      timedOut ? 'Payment API request timed out' : 'Operation aborted',
      cause,
    );
  }
  if (cause instanceof AgentkitRuntimeError) return cause;
  return new PaymentRequestError(
    ErrorCodes.ADAPTER_REQUEST_FAILED,
    status === undefined
      ? 'Payment API request failed'
      : invalidJson
        ? `Payment API returned invalid JSON (${status})`
        : `Cannot read payment API response body (${status})`,
    cause,
  );
}

/** Covers response-body reads too: AbortSignal.timeout remains live after headers arrive. */
export function paymentFetch(
  origin: string,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal; timeoutMs?: number } = {},
): typeof fetch {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = options.timeoutMs ?? 30_000;
  if (!isValidTimeout(timeout)) invalid('Invalid request timeout');
  return async (input, init) => {
    if (options.signal?.aborted)
      throw new PaymentRequestError(ErrorCodes.ABORTED, 'Operation aborted', options.signal.reason);
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== origin || url.username || url.password) invalid('Payment request outside trusted origin');
    const deadline = AbortSignal.timeout(timeout);
    const signals = [deadline];
    if (options.signal) signals.push(options.signal);
    if (init?.signal) signals.push(init.signal);
    if (input instanceof Request) signals.push(input.signal);
    const combined = AbortSignal.any(signals);
    const requestSignals = { combined, deadline };
    if (combined.aborted) throw requestFailure(combined.reason, requestSignals);
    let response: Response;
    try {
      response = await fetchImpl(input, { ...init, redirect: 'error', signal: combined });
    } catch (cause) {
      throw requestFailure(cause, requestSignals);
    }
    if (response.url && new URL(response.url).origin !== origin)
      invalidResponse('Payment response outside trusted origin');
    responseSignals.set(response, requestSignals);
    return response;
  };
}

export async function jsonObject(
  response: Response,
  { clone = false }: { clone?: boolean } = {},
): Promise<Record<string, unknown>> {
  let body: string;
  try {
    body = await (clone ? response.clone() : response).text();
  } catch (cause) {
    throw requestFailure(cause, responseSignals.get(response), response.status);
  }
  let data: unknown;
  try {
    // Own the parse boundary: fetch implementations can wrap JSON syntax errors
    // with private body fragments under arbitrary error names or causes.
    data = JSON.parse(body);
  } catch {
    throw requestFailure(undefined, responseSignals.get(response), response.status, true);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new AgentkitRuntimeError(ErrorCodes.ADAPTER_REQUEST_FAILED, 'Payment API returned a non-object response');
  }
  return data as Record<string, unknown>;
}
