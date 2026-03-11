import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';

export interface GetDetailsOutput {
  address: string;
  network: string;
  nativeBalance: string;
}

const inputSchema = z.object({});

export function getDetailsAction(wallet: WalletProvider): ActionDefinition<Record<string, never>, GetDetailsOutput> {
  return {
    name: 'wallet.get_details',
    description: 'Get wallet details including address, network, and native balance',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(_ctx, _input) {
      const [address, network, nativeBalance] = await Promise.all([
        wallet.getAddress(),
        wallet.getNetwork(),
        wallet.getBalance(),
      ]);
      return { address, network, nativeBalance };
    },
  };
}
