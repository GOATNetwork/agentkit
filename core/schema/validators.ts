import { z } from 'zod';

/** Zod schema for a valid EVM address (0x + 40 hex chars, case-insensitive). */
export const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Invalid EVM address');
