import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { PEGBTC_ADDRESS } from './stake.register-pubkey';

export interface PegBtcBalanceInput {
  address?: string;
}

export interface PegBtcBalanceOutput {
  address: string;
  balance: string;
}

const inputSchema = z.object({
  address: z.string().optional(),
});

export function bitvm2PegBtcBalanceAction(
  wallet: WalletProvider,
): ActionDefinition<PegBtcBalanceInput, PegBtcBalanceOutput> {
  return {
    name: 'goat.bitvm2.pegbtc.balance',
    description: 'Get PegBTC token balance for an address. PegBTC is the BitVM2 bridge token on Goat Network.',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(_ctx, input) {
      const addr = input.address ?? await wallet.getAddress();
      const balance = await wallet.getErc20Balance(PEGBTC_ADDRESS, addr);
      return { address: addr, balance };
    },
  };
}
