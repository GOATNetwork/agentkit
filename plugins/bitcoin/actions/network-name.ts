import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { BITCOIN_ADDRESS } from './block-hash';

export interface BitcoinNetworkNameOutput {
  networkName: string;
}

const inputSchema = z.object({});

const NETWORK_NAME_ABI = ['function networkName() view returns (string)'];

export function bitcoinNetworkNameAction(
  wallet: WalletProvider,
): ActionDefinition<Record<string, never>, BitcoinNetworkNameOutput> {
  return {
    name: 'bitcoin.network_name',
    description: 'Get the Bitcoin network name (e.g. mainnet, testnet3) from the on-chain oracle',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(_ctx, _input) {
      const networkName = await wallet.callContract(
        BITCOIN_ADDRESS,
        NETWORK_NAME_ABI,
        'networkName',
        [],
      );
      return { networkName: String(networkName) };
    },
  };
}
