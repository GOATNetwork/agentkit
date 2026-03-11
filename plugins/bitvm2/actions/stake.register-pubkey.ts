import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';

export const GATEWAY_ADDRESS = '0x440c6dCA87C3511E1eBf4FDB1f584ddaA49dD029';
export const STAKE_MANAGEMENT_ADDRESS = '0x4B6BD356FE9Ad077c6E3691BB2838e814B3F4032';
export const PEGBTC_ADDRESS = '0xdA97429ea2082334C63813f092B6A6209bfC4DEb';

export interface RegisterPubkeyInput {
  xonlyPubkey: string;
}

export interface RegisterPubkeyOutput {
  txHash: string;
}

const inputSchema = z.object({
  xonlyPubkey: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'xonlyPubkey must be a 32-byte hex string (0x + 64 hex chars)'),
});

const REGISTER_PUBKEY_ABI = ['function registerPubkey(bytes32 xonlyPubkey)'];

export function bitvm2RegisterPubkeyAction(
  wallet: WalletProvider,
): ActionDefinition<RegisterPubkeyInput, RegisterPubkeyOutput> {
  return {
    name: 'goat.bitvm2.stake.register_pubkey',
    description: 'Register an x-only public key (32 bytes) with the BitVM2 StakeManagement contract. This is the first step in the staking flow. X-only pubkeys are derived by removing the leading 02/03 prefix from a compressed 33-byte public key.',
    riskLevel: 'high',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      return wallet.writeContract(
        STAKE_MANAGEMENT_ADDRESS,
        REGISTER_PUBKEY_ABI,
        'registerPubkey',
        [input.xonlyPubkey],
        undefined,
        { signal: ctx.signal },
      );
    },
  };
}
