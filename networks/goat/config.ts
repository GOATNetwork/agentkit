export interface GoatNetworkConfig {
  key: 'goat-mainnet' | 'goat-testnet';
  chainId: number;
  rpcUrl: string;
}

/**
 * Per-network defaults. `rpcUrl` is exposed via a getter so the env var is
 * read at PROPERTY-ACCESS time, not module-import time. Without this lazy
 * read, any consumer that calls `dotenv` / `loadEnvFromCwd()` AFTER
 * importing this module silently keeps the hardcoded default — the CLI
 * shims (`bin/gns.mjs`, `bin/giftcard.mjs`) hit exactly that ordering
 * because `loadEnvFromCwd()` runs inside `runGnsCli` / `runGiftcardCli`,
 * after all imports complete.
 */
export const goatNetworks: Record<GoatNetworkConfig['key'], GoatNetworkConfig> = {
  'goat-mainnet': {
    key: 'goat-mainnet',
    chainId: 2345,
    get rpcUrl(): string {
      return process.env.GOAT_MAINNET_RPC_URL ?? 'https://rpc.goat.network';
    },
  },
  'goat-testnet': {
    key: 'goat-testnet',
    chainId: 48816,
    get rpcUrl(): string {
      return process.env.GOAT_TESTNET_RPC_URL ?? 'https://rpc.testnet3.goat.network';
    },
  },
};
