import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { evmAddress } from '../../../core/schema/validators';
import { WGBTC_ADDRESS } from './wrap';

export interface WgbtcBalanceInput {
  address?: string;
}

export interface WgbtcBalanceOutput {
  tokenAddress: string;
  balance: string;
}

const inputSchema = z.object({
  address: evmAddress.optional(),
});

export function wgbtcBalanceAction(wallet: WalletProvider): ActionDefinition<WgbtcBalanceInput, WgbtcBalanceOutput> {
  return {
    name: 'wgbtc.balance',
    description: 'Query WGBTC token balance for an address',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(_ctx, input) {
      const balance = await wallet.getErc20Balance(WGBTC_ADDRESS, input.address);
      return { tokenAddress: WGBTC_ADDRESS, balance };
    },
  };
}
