import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { GiftcardGateway, SupportedTokensResponse } from '../adapters/types';

export type ListSupportedTokensInput = Record<string, never>;

export type ListSupportedTokensOutput = SupportedTokensResponse;

const inputSchema = z.object({}).strict();

const tokenSchema = z
  .object({
    chain_id: z.number().int(),
    token_symbol: z.union([z.literal('USDC'), z.literal('USDT')]),
    token_contract: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'token_contract must be 0x address'),
    decimals: z.number().int().min(0).max(36),
    chain_name: z.string().optional(),
  })
  .passthrough();

const outputSchema = z.object({
  tokens: z.array(tokenSchema),
});

type GatewaySlice = Pick<GiftcardGateway, 'listSupportedTokens'>;

export function listSupportedTokensAction(
  gateway: GatewaySlice,
): ActionDefinition<ListSupportedTokensInput, ListSupportedTokensOutput> {
  return {
    name: 'goat.giftcard.listSupportedTokens',
    description: 'List supported payment chains and tokens (USDC/USDT per chain).',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: [],
    zodInputSchema: inputSchema,
    zodOutputSchema: outputSchema,
    async execute(ctx) {
      return gateway.listSupportedTokens(ctx.signal);
    },
  };
}
