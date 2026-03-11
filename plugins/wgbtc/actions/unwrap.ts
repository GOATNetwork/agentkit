import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { WGBTC_ADDRESS } from './wrap';

export interface WgbtcUnwrapInput {
  amountWei: string;
}

export interface WgbtcUnwrapOutput {
  txHash: string;
}

const inputSchema = z.object({
  amountWei: z.string().regex(/^\d+$/, 'amountWei must be a decimal integer string'),
});

const WGBTC_WITHDRAW_ABI = ['function withdraw(uint256)'];

export function wgbtcUnwrapAction(wallet: WalletProvider): ActionDefinition<WgbtcUnwrapInput, WgbtcUnwrapOutput> {
  return {
    name: 'wgbtc.unwrap',
    description: 'Unwrap WGBTC back to native BTC by calling withdraw on the WGBTC contract',
    riskLevel: 'high',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      return wallet.writeContract(WGBTC_ADDRESS, WGBTC_WITHDRAW_ABI, 'withdraw', [input.amountWei], undefined, { signal: ctx.signal });
    },
  };
}
