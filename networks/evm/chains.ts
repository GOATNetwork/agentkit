export interface ChainMetadata {
  chainId: number;
  displayName: string;
  isTestnet: boolean;
}

export const EVM_CHAIN_METADATA: readonly ChainMetadata[] = Object.freeze([
  { chainId: 1, displayName: 'Ethereum', isTestnet: false },
  { chainId: 10, displayName: 'Optimism', isTestnet: false },
  { chainId: 56, displayName: 'BNB Smart Chain', isTestnet: false },
  { chainId: 137, displayName: 'Polygon', isTestnet: false }, // frontend-listed but not in giftcard prod
  { chainId: 1088, displayName: 'Metis', isTestnet: false }, // frontend-listed but not in giftcard prod
  { chainId: 2345, displayName: 'GOAT Mainnet', isTestnet: false },
  { chainId: 8453, displayName: 'Base', isTestnet: false },
  { chainId: 42161, displayName: 'Arbitrum One', isTestnet: false },
  { chainId: 48816, displayName: 'GOAT Testnet3', isTestnet: true },
]);

function assertUniqueChainIds(table: readonly ChainMetadata[]): void {
  const seen = new Set<number>();
  for (const entry of table) {
    if (seen.has(entry.chainId)) {
      throw new Error(`Duplicate chainId ${entry.chainId} in EVM_CHAIN_METADATA`);
    }
    seen.add(entry.chainId);
  }
}
assertUniqueChainIds(EVM_CHAIN_METADATA);

export function getChainMetadata(chainId: number): ChainMetadata {
  const found = EVM_CHAIN_METADATA.find((c) => c.chainId === chainId);
  if (found) return found;
  return { chainId, displayName: `EVM chain ${chainId}`, isTestnet: false };
}
