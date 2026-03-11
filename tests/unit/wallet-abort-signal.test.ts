import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Viem mocks ---
const mockSendTransaction = vi.fn();
const mockViemWriteContract = vi.fn();
const mockViemDeployContract = vi.fn();
const mockWaitForTransactionReceipt = vi.fn();

vi.mock('viem', () => ({
  createWalletClient: vi.fn(() => ({
    getAddresses: vi.fn().mockResolvedValue(['0xABCD']),
    sendTransaction: mockSendTransaction,
    writeContract: mockViemWriteContract,
    deployContract: mockViemDeployContract,
    signTypedData: vi.fn().mockResolvedValue('0xsig'),
    chain: { id: 2346, name: 'goat-testnet' },
    account: { address: '0xABCD' },
  })),
  createPublicClient: vi.fn(() => ({
    getBalance: vi.fn().mockResolvedValue(BigInt(1000)),
    readContract: vi.fn().mockResolvedValue(BigInt(500)),
    waitForTransactionReceipt: mockWaitForTransactionReceipt,
  })),
  parseAbi: vi.fn((abi: string[]) => abi),
}));

import { ViemWalletProvider } from '../../core/wallet/viem-wallet-provider';

const mockAccount = { address: '0xABCD', type: 'local' } as any;
const mockChain = { id: 2346, name: 'goat-testnet' } as any;
const mockTransport = {} as any;

describe('ViemWalletProvider abort signal', () => {
  let provider: ViemWalletProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSendTransaction.mockResolvedValue('0xtxhash');
    mockViemWriteContract.mockResolvedValue('0xtxhash');
    mockViemDeployContract.mockResolvedValue('0xtxhash');
    mockWaitForTransactionReceipt.mockResolvedValue({ contractAddress: '0xNEW' });
    provider = new ViemWalletProvider(mockAccount, mockChain, mockTransport, 'goat-testnet');
  });

  it('rejects immediately if signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(provider.transferNative('0xTO', '100', { signal: controller.signal }))
      .rejects.toThrow('Operation aborted');
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });

  it('aborts during sendTransaction submission', async () => {
    const controller = new AbortController();
    mockSendTransaction.mockImplementation(() =>
      new Promise((resolve) => setTimeout(() => resolve('0xtxhash'), 500))
    );

    const promise = provider.transferNative('0xTO', '100', { signal: controller.signal });
    // Abort while sendTransaction is still pending
    setTimeout(() => controller.abort(), 10);
    await expect(promise).rejects.toThrow('Operation aborted');
  });

  it('aborts during writeContract submission', async () => {
    const controller = new AbortController();
    mockViemWriteContract.mockImplementation(() =>
      new Promise((resolve) => setTimeout(() => resolve('0xtxhash'), 500))
    );

    const promise = provider.writeContract(
      '0xCONTRACT', ['function foo(uint256)'], 'foo', [42],
      undefined, { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 10);
    await expect(promise).rejects.toThrow('Operation aborted');
  });

  it('aborts during waitForTransactionReceipt', async () => {
    const controller = new AbortController();
    mockWaitForTransactionReceipt.mockImplementation(() =>
      new Promise((resolve) => setTimeout(() => resolve({ contractAddress: null }), 500))
    );

    const promise = provider.transferNative('0xTO', '100', { signal: controller.signal });
    // sendTransaction resolves fast, but receipt is slow
    setTimeout(() => controller.abort(), 10);
    await expect(promise).rejects.toThrow('Operation aborted');
    expect(mockSendTransaction).toHaveBeenCalled();
  });

  it('aborts during deployContract submission', async () => {
    const controller = new AbortController();
    mockViemDeployContract.mockImplementation(() =>
      new Promise((resolve) => setTimeout(() => resolve('0xtxhash'), 500))
    );

    const promise = provider.deployContract(
      ['constructor(uint256)'], '0x6080', [42],
      undefined, { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 10);
    await expect(promise).rejects.toThrow('Operation aborted');
  });

  it('succeeds normally when signal is not aborted', async () => {
    const controller = new AbortController();
    const result = await provider.transferNative('0xTO', '100', { signal: controller.signal });
    expect(result).toEqual({ txHash: '0xtxhash' });
  });
});

// --- EvmWalletProvider abort tests (ethers-style mocks) ---
describe('EvmWalletProvider abort signal', () => {
  // We import EvmWalletProvider directly and construct with mock signer/provider
  // Since EvmWalletProvider uses ethers Contract dynamically, we mock at the signer level

  function makeMockSigner(sendDelay = 0) {
    const mockTx = {
      hash: '0xethers_tx',
      wait: vi.fn().mockResolvedValue({ hash: '0xethers_receipt' }),
    };
    return {
      signer: {
        getAddress: vi.fn().mockResolvedValue('0xABCD'),
        sendTransaction: vi.fn().mockImplementation(() =>
          sendDelay > 0
            ? new Promise((r) => setTimeout(() => r(mockTx), sendDelay))
            : Promise.resolve(mockTx)
        ),
        signTypedData: vi.fn().mockResolvedValue('0xsig'),
      } as any,
      provider: {
        getBalance: vi.fn().mockResolvedValue(BigInt(1000)),
      } as any,
      mockTx,
    };
  }

  it('rejects immediately if signal is already aborted', async () => {
    const { EvmWalletProvider } = await import('../../core/wallet/evm-wallet-provider');
    const { signer, provider: mockProvider } = makeMockSigner();
    const evmProvider = new EvmWalletProvider(signer, mockProvider);
    const controller = new AbortController();
    controller.abort();

    await expect(evmProvider.transferNative('0xTO', '100', { signal: controller.signal }))
      .rejects.toThrow('Operation aborted');
    expect(signer.sendTransaction).not.toHaveBeenCalled();
  });

  it('aborts during sendTransaction submission', async () => {
    const { EvmWalletProvider } = await import('../../core/wallet/evm-wallet-provider');
    const { signer, provider: mockProvider } = makeMockSigner(500);
    const evmProvider = new EvmWalletProvider(signer, mockProvider);
    const controller = new AbortController();

    const promise = evmProvider.transferNative('0xTO', '100', { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(promise).rejects.toThrow('Operation aborted');
  });

  it('aborts during tx.wait()', async () => {
    const { EvmWalletProvider } = await import('../../core/wallet/evm-wallet-provider');
    const { signer, provider: mockProvider, mockTx } = makeMockSigner();
    // Make wait() slow
    mockTx.wait.mockImplementation(() => new Promise((r) => setTimeout(() => r({ hash: '0xreceipt' }), 500)));
    const evmProvider = new EvmWalletProvider(signer, mockProvider);
    const controller = new AbortController();

    const promise = evmProvider.transferNative('0xTO', '100', { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(promise).rejects.toThrow('Operation aborted');
    expect(signer.sendTransaction).toHaveBeenCalled();
  });

  it('succeeds normally when signal is not aborted', async () => {
    const { EvmWalletProvider } = await import('../../core/wallet/evm-wallet-provider');
    const { signer, provider: mockProvider } = makeMockSigner();
    const evmProvider = new EvmWalletProvider(signer, mockProvider);
    const controller = new AbortController();

    const result = await evmProvider.transferNative('0xTO', '100', { signal: controller.signal });
    expect(result).toEqual({ txHash: '0xethers_receipt' });
  });
});
