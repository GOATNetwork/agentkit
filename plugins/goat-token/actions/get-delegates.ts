import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { GOAT_TOKEN_ADDRESS } from './delegate';

export interface GoatTokenGetDelegatesInput {
  address: string;
}

export interface GoatTokenGetDelegatesOutput {
  address: string;
  delegatee: string;
}

const inputSchema = z.object({
  address: z.string().min(4, 'address must be a valid address'),
});

const DELEGATES_ABI = ['function delegates(address) view returns (address)'];

export function goatTokenGetDelegatesAction(
  wallet: WalletProvider,
): ActionDefinition<GoatTokenGetDelegatesInput, GoatTokenGetDelegatesOutput> {
  return {
    name: 'goat_token.get_delegates',
    description: 'Get the address that a given account has delegated their GOAT voting power to',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(_ctx, input) {
      const delegatee = await wallet.callContract(
        GOAT_TOKEN_ADDRESS,
        DELEGATES_ABI,
        'delegates',
        [input.address],
      );
      return { address: input.address, delegatee: String(delegatee) };
    },
  };
}
