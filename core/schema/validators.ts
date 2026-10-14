import { z } from 'zod';

/** Zod schema for a valid EVM address (0x + 40 hex chars, case-insensitive). */
export const evmAddressPattern = /^0x[0-9a-fA-F]{40}$/;
export const evmAddress = z.string().regex(evmAddressPattern, 'Invalid EVM address');

/** Positive integer wei within the EVM uint256 range; decimal amounts are separate. */
export function isPositiveUint256(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value) && BigInt(value) > 0n && BigInt(value) < 2n ** 256n;
}
export const positiveUint256 = z.string().refine(isPositiveUint256, 'Expected positive integer wei within uint256');
export const txHashPattern = /^0x[0-9a-fA-F]{64}$/;
export const transactionHash = z.string().regex(txHashPattern, 'Invalid transaction hash');
