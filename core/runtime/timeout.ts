/** Largest delay Node timers accept without clamping it to one millisecond. */
export const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export function isValidTimeout(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_TIMEOUT_MS;
}
