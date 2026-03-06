import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { STAKE_MANAGEMENT_ADDRESS, PEGBTC_ADDRESS } from './stake.register-pubkey';

export interface StakeApproveInput {
  amount: string;
}

export interface StakeApproveOutput {
  txHash: string;
}

const inputSchema = z.object({
  amount: z.string().regex(/^\d+$/, 'amount must be a numeric string in wei'),
});

export function bitvm2StakeApproveAction(
  wallet: WalletProvider,
): ActionDefinition<StakeApproveInput, StakeApproveOutput> {
  return {
    name: 'goat.bitvm2.stake.approve',
    description: 'Approve PegBTC tokens for the BitVM2 StakeManagement contract. This is the second step in the staking flow (after registerPubkey). The amount must be >= the amount you intend to stake.',
    riskLevel: 'high',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      return wallet.approveErc20(PEGBTC_ADDRESS, STAKE_MANAGEMENT_ADDRESS, input.amount, { signal: ctx.signal });
    },
  };
}
