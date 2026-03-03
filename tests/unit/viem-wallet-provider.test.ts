import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetAddresses = vi.fn().mockResolvedValue(['0xABCD']);
const mockSendTransaction = vi.fn().mockResolvedValue('0xtxhash');
const mockWriteContract = vi.fn().mockResolvedValue('0xtxhash');
const mockDeployContract = vi.fn().mockResolvedValue('0xtxhash');
const mockSignTypedData = vi.fn().mockResolvedValue('0xsig');
const mockGetBalance = vi.fn().mockResolvedValue(BigInt(1000));
const mockReadContract = vi.fn().mockResolvedValue(BigInt(500));
const mockWaitForTransactionReceipt = vi
  .fn()
  .mockResolvedValue({ contractAddress: '0xNEWCONTRACT' });

vi.mock('viem', () => ({
  createWalletClient: vi.fn(() => ({
    getAddresses: mockGetAddresses,
    sendTransaction: mockSendTransaction,
    writeContract: mockWriteContract,
    deployContract: mockDeployContract,
    signTypedData: mockSignTypedData,
    chain: { id: 2346, name: 'goat-testnet' },
    account: { address: '0xABCD' },
  })),
  createPublicClient: vi.fn(() => ({
    getBalance: mockGetBalance,
    readContract: mockReadContract,
    waitForTransactionReceipt: mockWaitForTransactionReceipt,
  })),
  parseAbi: vi.fn((abi: string[]) => abi),
  formatEther: vi.fn((v: bigint) => v.toString()),
}));

import { ViemWalletProvider } from '../../core/wallet/viem-wallet-provider';

const mockAccount = { address: '0xABCD', type: 'local' } as any;
const mockChain = { id: 2346, name: 'goat-testnet' } as any;
const mockTransport = {} as any;

describe('ViemWalletProvider', () => {
  let provider: ViemWalletProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAddresses.mockResolvedValue(['0xABCD']);
    mockSendTransaction.mockResolvedValue('0xtxhash');
    mockWriteContract.mockResolvedValue('0xtxhash');
    mockDeployContract.mockResolvedValue('0xtxhash');
    mockGetBalance.mockResolvedValue(BigInt(1000));
    mockReadContract.mockResolvedValue(BigInt(500));
    mockWaitForTransactionReceipt.mockResolvedValue({ contractAddress: '0xNEWCONTRACT' });
    provider = new ViemWalletProvider(mockAccount, mockChain, mockTransport, 'goat-testnet');
  });

  it('getAddress returns first wallet address', async () => {
    expect(await provider.getAddress()).toBe('0xABCD');
  });

  it('getNetwork returns configured network name', async () => {
    expect(await provider.getNetwork()).toBe('goat-testnet');
  });

  it('getBalance returns balance as string', async () => {
    expect(await provider.getBalance()).toBe('1000');
    expect(mockGetBalance).toHaveBeenCalled();
  });

  it('getErc20Balance reads ERC20 balanceOf', async () => {
    expect(await provider.getErc20Balance('0xTOKEN')).toBe('500');
    expect(mockReadContract).toHaveBeenCalled();
  });

  it('transferNative sends transaction and waits for receipt', async () => {
    const result = await provider.transferNative('0xTO', '1000');
    expect(result).toEqual({ txHash: '0xtxhash' });
    expect(mockSendTransaction).toHaveBeenCalled();
    expect(mockWaitForTransactionReceipt).toHaveBeenCalledWith({ hash: '0xtxhash' });
  });

  it('transferErc20 calls writeContract on token', async () => {
    const result = await provider.transferErc20('0xTOKEN', '0xTO', '100');
    expect(result).toEqual({ txHash: '0xtxhash' });
    expect(mockWriteContract).toHaveBeenCalled();
  });

  it('approveErc20 calls writeContract with approve', async () => {
    const result = await provider.approveErc20('0xTOKEN', '0xSPENDER', '100');
    expect(result).toEqual({ txHash: '0xtxhash' });
    expect(mockWriteContract).toHaveBeenCalled();
  });

  it('signTypedData delegates to walletClient', async () => {
    const result = await provider.signTypedData(
      { name: 'Test' },
      { Foo: [{ name: 'bar', type: 'uint256' }] },
      { bar: 42 },
    );
    expect(result).toBe('0xsig');
    expect(mockSignTypedData).toHaveBeenCalled();
  });

  it('callContract uses publicClient.readContract', async () => {
    const result = await provider.callContract('0xCONTRACT', ['function foo() view returns (uint256)'], 'foo', []);
    expect(result).toBe(BigInt(500));
    expect(mockReadContract).toHaveBeenCalled();
  });

  it('writeContract sends tx and waits for receipt', async () => {
    const result = await provider.writeContract(
      '0xCONTRACT',
      ['function bar(uint256)'],
      'bar',
      [42],
    );
    expect(result).toEqual({ txHash: '0xtxhash' });
    expect(mockWriteContract).toHaveBeenCalled();
    expect(mockWaitForTransactionReceipt).toHaveBeenCalled();
  });

  it('writeContract passes value for payable calls', async () => {
    await provider.writeContract('0xCONTRACT', ['function bar() payable'], 'bar', [], '1000');
    expect(mockWriteContract).toHaveBeenCalledWith(
      expect.objectContaining({ value: BigInt(1000) }),
    );
  });

  it('deployContract sends deploy tx and returns address from receipt', async () => {
    const result = await provider.deployContract(
      ['constructor(uint256)'],
      '0x6080',
      [42],
    );
    expect(result).toEqual({ txHash: '0xtxhash', contractAddress: '0xNEWCONTRACT' });
    expect(mockDeployContract).toHaveBeenCalled();
    expect(mockWaitForTransactionReceipt).toHaveBeenCalledWith({ hash: '0xtxhash' });
  });

  it('deployContract passes value for payable constructors', async () => {
    await provider.deployContract(['constructor() payable'], '0x6080', [], '5000');
    expect(mockDeployContract).toHaveBeenCalledWith(
      expect.objectContaining({ value: BigInt(5000) }),
    );
  });
});
