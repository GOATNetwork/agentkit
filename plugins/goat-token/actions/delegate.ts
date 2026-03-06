import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';

export const GOAT_TOKEN_ADDRESS = '0xbC10000000000000000000000000000000000001';

export interface GoatTokenDelegateInput {
  delegatee: string;
}

export interface GoatTokenDelegateOutput {
  txHash: string;
}

const inputSchema = z.object({
  delegatee: z.string().min(4, 'delegatee must be a valid address'),
});

const DELEGATE_ABI = ['function delegate(address)'];

export function goatTokenDelegateAction(
  wallet: WalletProvider,
): ActionDefinition<GoatTokenDelegateInput, GoatTokenDelegateOutput> {
  return {
    name: 'goat_token.delegate',
    description: 'Delegate GOAT token voting power to the specified address',
    riskLevel: 'medium',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      return wallet.writeContract(GOAT_TOKEN_ADDRESS, DELEGATE_ABI, 'delegate', [input.delegatee], undefined, { signal: ctx.signal });
    },
  };
}
