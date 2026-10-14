import { AgentkitRuntimeError } from '../errors/error';
import { ErrorCodes } from '../errors/error-codes';

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AgentkitRuntimeError(ErrorCodes.ABORTED, 'Operation aborted');
}

/** Only race reads or confirmation waits; never abandon a submission RPC. */
export function raceSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new AgentkitRuntimeError(ErrorCodes.ABORTED, 'Operation aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    // Attach handlers even for an already-aborted signal: the read may reject later.
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}
