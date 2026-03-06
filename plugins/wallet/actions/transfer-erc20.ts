import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { evmAddress } from '../../../core/schema/validators';

export interface TransferErc20Input {
  tokenAddress: string;
  to: string;
  amount: string;
}

export interface TransferErc20Output {
  txHash: string;
}

const inputSchema = z.object({
  tokenAddress: evmAddress,
  to: evmAddress,
  amount: z.string().regex(/^\d+$/),
});

export function transferErc20Action(wallet: WalletProvider): ActionDefinition<TransferErc20Input, TransferErc20Output> {
  return {
    name: 'wallet.transfer_erc20',
    description: 'Transfer ERC20 tokens to an address',
    riskLevel: 'high',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      return wallet.transferErc20(input.tokenAddress, input.to, input.amount, { signal: ctx.signal });
    },
  };
}
