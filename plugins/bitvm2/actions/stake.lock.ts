import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { STAKE_MANAGEMENT_ADDRESS } from './stake.register-pubkey';

export interface LockStakeInput {
  amount: string;
}

export interface LockStakeOutput {
  txHash: string;
}

const inputSchema = z.object({
  amount: z.string().regex(/^\d+$/, 'amount must be a numeric string in wei. Minimum: 60000000000000000 (0.06 PBTC)'),
});

const LOCK_STAKE_ABI = ['function lockStake(uint256 amount)'];

export function bitvm2LockStakeAction(
  wallet: WalletProvider,
): ActionDefinition<LockStakeInput, LockStakeOutput> {
  return {
    name: 'goat.bitvm2.stake.lock',
    description: 'Lock staked PegBTC in the BitVM2 StakeManagement contract. This is the fourth and final step in the staking flow. Minimum lock amount is 0.06 PBTC (60000000000000000 wei). Each disprove slash costs 0.03 PBTC. The locked amount must be <= staked amount.',
    riskLevel: 'high',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      return wallet.writeContract(
        STAKE_MANAGEMENT_ADDRESS,
        LOCK_STAKE_ABI,
        'lockStake',
        [BigInt(input.amount)],
        undefined,
        { signal: ctx.signal },
      );
    },
  };
}
