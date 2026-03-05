import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletReadAdapter } from '../adapters/types';
import { evmAddress } from '../../../core/schema/validators';

export interface WalletBalanceInput {
  address: string;
  tokenAddress?: string;
}

export interface WalletBalanceOutput {
  address: string;
  tokenAddress?: string;
  balance: string;
}

const inputSchema = z.object({
  address: evmAddress,
  tokenAddress: evmAddress.optional(),
});

export function walletBalanceAction(adapter: WalletReadAdapter): ActionDefinition<WalletBalanceInput, WalletBalanceOutput> {
  return {
    name: 'wallet.balance',
    description: 'Query wallet balance (native token when tokenAddress absent, ERC20 otherwise)',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(_ctx, input) {
      return adapter.getBalance(input);
    },
  };
}
