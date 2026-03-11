import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';

export const WGBTC_ADDRESS = '0xBC10000000000000000000000000000000000000';

export interface WgbtcWrapInput {
  amountWei: string;
}

export interface WgbtcWrapOutput {
  txHash: string;
}

const inputSchema = z.object({
  amountWei: z.string().regex(/^\d+$/, 'amountWei must be a decimal integer string'),
});

export function wgbtcWrapAction(wallet: WalletProvider): ActionDefinition<WgbtcWrapInput, WgbtcWrapOutput> {
  return {
    name: 'wgbtc.wrap',
    description: 'Wrap native BTC into WGBTC by sending BTC to the WGBTC contract',
    riskLevel: 'high',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      return wallet.transferNative(WGBTC_ADDRESS, input.amountWei, { signal: ctx.signal });
    },
  };
}
