import { describe, it, expect, vi } from 'vitest';
import { NoopWalletProvider } from '../../core/wallet/noop-wallet-provider';
import { EvmWalletProvider } from '../../core/wallet/evm-wallet-provider';
import { ViemWalletProvider } from '../../core/wallet/viem-wallet-provider';

describe('NoopWalletProvider.getChainId', () => {
  it('defaults to GOAT Testnet3 chainId 48816 when no options provided', async () => {
    const wallet = new NoopWalletProvider();
    await expect(wallet.getChainId()).resolves.toBe(48816);
  });

  it('returns the configured chainId when supplied via options bag', async () => {
    const wallet = new NoopWalletProvider('0x0000000000000000000000000000000000000001', { chainId: 8453 });
    await expect(wallet.getChainId()).resolves.toBe(8453);
  });

  it('returns the configured networkName when supplied via options bag', async () => {
    const wallet = new NoopWalletProvider('0x0000000000000000000000000000000000000001', {
      networkName: 'base-mainnet',
      chainId: 8453,
    });
    await expect(wallet.getNetwork()).resolves.toBe('base-mainnet');
    await expect(wallet.getChainId()).resolves.toBe(8453);
  });
});

describe('EvmWalletProvider.getChainId', () => {
  it('exists on the prototype and returns Promise<number>', async () => {
    // Mock the underlying ethers Provider (only the .getNetwork() call is touched here).
    const mockProvider = {
      getNetwork: vi.fn().mockResolvedValue({ chainId: 8453n }),
    } as unknown as ConstructorParameters<typeof EvmWalletProvider>[1];
    const mockSigner = {} as ConstructorParameters<typeof EvmWalletProvider>[0];

    const wallet = new EvmWalletProvider(mockSigner, mockProvider, 'base-mainnet');
    const result = wallet.getChainId();
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBe(8453);
    expect(typeof (await result)).toBe('number');
  });
});

describe('ViemWalletProvider.getChainId', () => {
  it('delegates to publicClient.getChainId()', async () => {
    // Construct with minimal stubs; then patch the private publicClient via a cast.
    const mockAccount = { address: '0x0000000000000000000000000000000000000001' } as unknown as Parameters<
      typeof ViemWalletProvider.prototype.constructor
    >[0];
    const mockChain = { id: 8453, name: 'base' } as unknown as Parameters<
      typeof ViemWalletProvider.prototype.constructor
    >[1];
    const mockTransport = (() => ({})) as unknown as Parameters<typeof ViemWalletProvider.prototype.constructor>[2];

    const wallet = new ViemWalletProvider(mockAccount, mockChain, mockTransport, 'base-mainnet');

    // Replace the publicClient on the instance with a stub that exposes getChainId.
    (wallet as unknown as { publicClient: { getChainId: () => Promise<number> } }).publicClient = {
      getChainId: vi.fn().mockResolvedValue(8453),
    };

    const result = wallet.getChainId();
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBe(8453);
    expect(typeof (await result)).toBe('number');
  });
});
