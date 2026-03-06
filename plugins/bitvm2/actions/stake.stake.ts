import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { STAKE_MANAGEMENT_ADDRESS } from './stake.register-pubkey';

export interface StakeInput {
  amount: string;
}

export interface StakeOutput {
  txHash: string;
}

const inputSchema = z.object({
  amount: z.string().regex(/^\d+$/, 'amount must be a numeric string in wei'),
});

const STAKE_ABI = ['function stake(uint256 amount)'];

export function bitvm2StakeAction(
  wallet: WalletProvider,
): ActionDefinition<StakeInput, StakeOutput> {
  return {
    name: 'goat.bitvm2.stake.stake',
    description: 'Stake PegBTC tokens with the BitVM2 StakeManagement contract. This is the third step in the staking flow (after approve). The amount must be <= previously approved amount.',
    riskLevel: 'high',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      return wallet.writeContract(
        STAKE_MANAGEMENT_ADDRESS,
        STAKE_ABI,
        'stake',
        [BigInt(input.amount)],
        undefined,
        { signal: ctx.signal },
      );
    },
  };
}
