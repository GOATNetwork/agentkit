import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { evmAddress } from '../../../core/schema/validators';

export interface ApproveErc20Input {
  tokenAddress: string;
  spender: string;
  amount: string;
}

export interface ApproveErc20Output {
  txHash: string;
}

const inputSchema = z.object({
  tokenAddress: evmAddress,
  spender: evmAddress,
  amount: z.string().regex(/^\d+$/),
});

export function approveErc20Action(wallet: WalletProvider): ActionDefinition<ApproveErc20Input, ApproveErc20Output> {
  return {
    name: 'wallet.approve_erc20',
    description: 'Approve ERC20 token spending allowance for a spender address',
    riskLevel: 'high',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      return wallet.approveErc20(input.tokenAddress, input.spender, input.amount, { signal: ctx.signal });
    },
  };
}
