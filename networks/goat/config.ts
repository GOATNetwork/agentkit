export interface GoatNetworkConfig {
  key: 'goat-mainnet' | 'goat-testnet';
  chainId: number;
  rpcUrl: string;
}

export const goatNetworks: Record<GoatNetworkConfig['key'], GoatNetworkConfig> = {
  'goat-mainnet': {
    key: 'goat-mainnet',
    chainId: 2345,
    rpcUrl: process.env.GOAT_MAINNET_RPC_URL ?? 'https://rpc.goat.network',
  },
  'goat-testnet': {
    key: 'goat-testnet',
    chainId: 2346,
    rpcUrl: process.env.GOAT_TESTNET_RPC_URL ?? 'https://rpc.testnet.goat.network',
  },
};
