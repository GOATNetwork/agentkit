import { describe, it, expect } from 'vitest';
import { EVM_CHAIN_METADATA, getChainMetadata } from '../../networks/evm/index';

describe('networks/evm/chains', () => {
  it('returns Base metadata for chainId 8453', () => {
    const meta = getChainMetadata(8453);
    expect(meta).toEqual({ chainId: 8453, displayName: 'Base', isTestnet: false });
  });

  it('returns GOAT Testnet3 metadata for chainId 48816', () => {
    const meta = getChainMetadata(48816);
    expect(meta).toEqual({ chainId: 48816, displayName: 'GOAT Testnet3', isTestnet: true });
  });

  it('returns a fallback entry for an unknown chainId', () => {
    const meta = getChainMetadata(999999);
    expect(meta).toEqual({ chainId: 999999, displayName: 'EVM chain 999999', isTestnet: false });
  });

  it('EVM_CHAIN_METADATA has no duplicate chainIds', () => {
    const ids = EVM_CHAIN_METADATA.map((c) => c.chainId);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});
