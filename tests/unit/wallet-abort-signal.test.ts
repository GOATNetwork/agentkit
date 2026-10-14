import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Viem mocks ---
const mockSendTransaction = vi.fn();
const mockPrepare = vi.fn();
const mockSign = vi.fn();
const mockBroadcast = vi.fn();
const mockViemWriteContract = vi.fn();
const mockViemDeployContract = vi.fn();
const mockWaitForTransactionReceipt = vi.fn();

vi.mock('viem', () => ({
  createWalletClient: vi.fn(() => ({
    getAddresses: vi.fn().mockResolvedValue(['0xABCD']),
    sendTransaction: mockSendTransaction,
    prepareTransactionRequest: mockPrepare,
    signTransaction: mockSign,
    sendRawTransaction: mockBroadcast,
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
  keccak256: vi.fn(() => '0x' + '55'.repeat(32)),
  encodeFunctionData: vi.fn(() => '0xabc'),
  encodeDeployData: vi.fn(() => '0x6080abc'),
  parseAbi: vi.fn((abi: string[]) => abi),
}));

import { ViemWalletProvider } from '../../core/wallet/viem-wallet-provider';

const mockAccount = { address: '0xABCD', type: 'local' } as any;
const mockChain = { id: 2346, name: 'goat-testnet' } as any;
const mockTransport = {} as any;

describe('ViemWalletProvider abort signal', () => {
  let provider: ViemWalletProvider;

  it.each(['prepare', 'sign'])('does not broadcast when cancellation arrives during %s', async (stage) => {
    const controller = new AbortController();
    (stage === 'prepare' ? mockPrepare : mockSign).mockImplementationOnce(async () => {
      await Promise.resolve();
      controller.abort();
      return stage === 'prepare' ? { data: '0xabc' } : '0xdeadbeef';
    });
    await expect(provider.broadcastErc20('0xTOKEN', '0xTO', '100', { signal: controller.signal })).rejects.toThrow(
      'Operation aborted',
    );
    expect(mockBroadcast).not.toHaveBeenCalled();
    if (stage === 'prepare') expect(mockSign).not.toHaveBeenCalled();
  });

  it('broadcastErc20 preserves a delayed hash after abort and does not wait for mining', async () => {
    const controller = new AbortController();
    mockBroadcast.mockImplementation(async () => {
      controller.abort();
      return '0xbroadcast';
    });
    expect(await provider.broadcastErc20('0xTOKEN', '0xTO', '100', { signal: controller.signal })).toEqual({
      txHash: '0xbroadcast',
    });
    expect(mockWaitForTransactionReceipt).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrepare.mockResolvedValue({ to: '0xTOKEN', data: '0xabc' });
    mockSign.mockResolvedValue('0xdeadbeef');
    mockBroadcast.mockResolvedValue('0xtxhash');
    mockSendTransaction.mockResolvedValue('0xtxhash');
    mockViemWriteContract.mockResolvedValue('0xtxhash');
    mockViemDeployContract.mockResolvedValue('0xtxhash');
    mockWaitForTransactionReceipt.mockResolvedValue({ status: 'success', contractAddress: '0xNEW' });
    provider = new ViemWalletProvider(mockAccount, mockChain, mockTransport, 'goat-testnet');
  });

  it('rejects immediately if signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(provider.transferNative('0xTO', '100', { signal: controller.signal })).rejects.toThrow(
      'Operation aborted',
    );
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });

  it('retains the hash when cancelled during submission', async () => {
    const controller = new AbortController();
    mockBroadcast.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve('0xtxhash'), 30)));

    const promise = provider.transferNative('0xTO', '100', { signal: controller.signal });
    // Abort while sendTransaction is still pending
    setTimeout(() => controller.abort(), 10);
    await expect(promise).rejects.toMatchObject({ code: 'ABORTED', recovery: { txHash: '0xtxhash' } });
  });

  it('retains the hash after cancelled writeContract submission', async () => {
    const controller = new AbortController();
    mockBroadcast.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve('0xtxhash'), 30)));

    const promise = provider.writeContract('0xCONTRACT', ['function foo(uint256)'], 'foo', [42], undefined, {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);
    await expect(promise).rejects.toMatchObject({ code: 'ABORTED', recovery: { txHash: '0xtxhash' } });
  });

  it('aborts during waitForTransactionReceipt', async () => {
    const controller = new AbortController();
    mockWaitForTransactionReceipt.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ contractAddress: null }), 500)),
    );

    const promise = provider.transferNative('0xTO', '100', { signal: controller.signal });
    // sendTransaction resolves fast, but receipt is slow
    setTimeout(() => controller.abort(), 10);
    await expect(promise).rejects.toMatchObject({ code: 'ABORTED', recovery: { txHash: '0xtxhash' } });
    expect(mockBroadcast).toHaveBeenCalled();
  });

  it('retains the hash after cancelled deployContract submission', async () => {
    const controller = new AbortController();
    mockBroadcast.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve('0xtxhash'), 30)));

    const promise = provider.deployContract(['constructor(uint256)'], '0x6080', [42], undefined, {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);
    await expect(promise).rejects.toMatchObject({ code: 'ABORTED', recovery: { txHash: '0xtxhash' } });
  });

  it('retains an approval hash after cancellation during its raw send', async () => {
    const controller = new AbortController();
    mockBroadcast.mockImplementationOnce(async () => {
      controller.abort();
      return '0xtxhash';
    });
    await expect(
      provider.approveErc20('0xTOKEN', '0xSPENDER', '10', { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'ABORTED', recovery: { txHash: '0xtxhash' } });
    expect(mockViemWriteContract).not.toHaveBeenCalled();
    expect(mockWaitForTransactionReceipt).not.toHaveBeenCalled();
  });

  it('reports unsupported JSON-RPC raw signing before any submission', async () => {
    mockSign.mockRejectedValueOnce({ cause: { code: -32601 } });
    await expect(provider.writeContract('0xTOKEN', ['function foo()'], 'foo', [])).rejects.toMatchObject({
      code: 'WALLET_SIGN_FAILED',
      message: expect.stringContaining('raw transaction signing'),
    });
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('succeeds normally when signal is not aborted', async () => {
    const controller = new AbortController();
    const result = await provider.transferNative('0xTO', '100', { signal: controller.signal });
    expect(result).toEqual({ txHash: '0xtxhash' });
  });
});

// --- EvmWalletProvider abort tests (ethers-style mocks) ---
describe('EvmWalletProvider abort signal', () => {
  it.each(['populateTransaction', 'signTransaction'])(
    'does not broadcast when cancellation arrives during %s',
    async (stage) => {
      const { EvmWalletProvider } = await import('../../core/wallet/evm-wallet-provider');
      const { signer, provider } = makeMockSigner();
      const controller = new AbortController();
      signer[stage].mockImplementationOnce(async () => {
        await Promise.resolve();
        controller.abort();
        return stage === 'populateTransaction' ? {} : '0xdeadbeef';
      });
      const wallet = new EvmWalletProvider(signer, provider);
      await expect(
        wallet.broadcastErc20(`0x${'11'.repeat(20)}`, `0x${'22'.repeat(20)}`, '100', { signal: controller.signal }),
      ).rejects.toMatchObject({ code: 'ABORTED' });
      expect(provider.broadcastTransaction).not.toHaveBeenCalled();
      if (stage === 'populateTransaction') expect(signer.signTransaction).not.toHaveBeenCalled();
    },
  );
  it('broadcastErc20 retains the submission hash without waiting for confirmations', async () => {
    const { EvmWalletProvider } = await import('../../core/wallet/evm-wallet-provider');
    const { signer, provider: mockProvider, mockTx } = makeMockSigner();
    const controller = new AbortController();
    mockProvider.broadcastTransaction.mockImplementation(async () => {
      controller.abort();
      return mockTx;
    });
    const wallet = new EvmWalletProvider(signer, mockProvider);
    expect(
      await wallet.broadcastErc20(`0x${'11'.repeat(20)}`, `0x${'22'.repeat(20)}`, '100', { signal: controller.signal }),
    ).toEqual({ txHash: '0xethers_tx' });
    expect(mockTx.wait).not.toHaveBeenCalled();
  });
  // We import EvmWalletProvider directly and construct with mock signer/provider
  // Since EvmWalletProvider uses ethers Contract dynamically, we mock at the signer level

  function makeMockSigner(sendDelay = 0) {
    const mockTx = {
      hash: '0xethers_tx',
      wait: vi.fn().mockResolvedValue({ hash: '0xethers_receipt' }),
    };
    const provider = {
      getBalance: vi.fn().mockResolvedValue(BigInt(1000)),
      broadcastTransaction: vi.fn(async () => {
        if (sendDelay) await new Promise((r) => setTimeout(r, sendDelay));
        return mockTx;
      }),
    };
    return {
      signer: {
        provider,
        populateTransaction: vi.fn(async (tx) => tx),
        signTransaction: vi.fn().mockResolvedValue('0xdeadbeef'),
        getAddress: vi.fn().mockResolvedValue('0xABCD'),
        sendTransaction: vi
          .fn()
          .mockImplementation(() =>
            sendDelay > 0 ? new Promise((r) => setTimeout(() => r(mockTx), sendDelay)) : Promise.resolve(mockTx),
          ),
        signTypedData: vi.fn().mockResolvedValue('0xsig'),
      } as any,
      provider: provider as any,
      mockTx,
    };
  }

  it('rejects immediately if signal is already aborted', async () => {
    const { EvmWalletProvider } = await import('../../core/wallet/evm-wallet-provider');
    const { signer, provider: mockProvider } = makeMockSigner();
    const evmProvider = new EvmWalletProvider(signer, mockProvider);
    const controller = new AbortController();
    controller.abort();

    await expect(evmProvider.transferNative('0xTO', '100', { signal: controller.signal })).rejects.toThrow(
      'Operation aborted',
    );
    expect(signer.sendTransaction).not.toHaveBeenCalled();
  });

  it('retains the hash when cancelled during submission', async () => {
    const { EvmWalletProvider } = await import('../../core/wallet/evm-wallet-provider');
    const { signer, provider: mockProvider } = makeMockSigner(30);
    const evmProvider = new EvmWalletProvider(signer, mockProvider);
    const controller = new AbortController();

    const promise = evmProvider.transferNative('0xTO', '100', { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(promise).rejects.toMatchObject({ code: 'ABORTED', recovery: { txHash: '0xethers_tx' } });
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
    expect(mockProvider.broadcastTransaction).toHaveBeenCalled();
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
