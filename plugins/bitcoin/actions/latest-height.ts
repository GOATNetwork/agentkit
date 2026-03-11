import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { BITCOIN_ADDRESS } from './block-hash';

export interface BitcoinLatestHeightOutput {
  height: string;
}

const inputSchema = z.object({});

const LATEST_HEIGHT_ABI = ['function latestHeight() view returns (uint256)'];

export function bitcoinLatestHeightAction(
  wallet: WalletProvider,
): ActionDefinition<Record<string, never>, BitcoinLatestHeightOutput> {
  return {
    name: 'bitcoin.latest_height',
    description: 'Get the latest Bitcoin block height known to the on-chain oracle',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(_ctx, _input) {
      const height = await wallet.callContract(
        BITCOIN_ADDRESS,
        LATEST_HEIGHT_ABI,
        'latestHeight',
        [],
      );
      return { height: String(height) };
    },
  };
}
