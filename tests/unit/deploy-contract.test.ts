import { describe, it, expect, vi } from 'vitest';
import { deployContractAction } from '../../plugins/wallet/index';
import type { WalletProvider } from '../../core/wallet/wallet-provider';

function mockWallet(overrides: Partial<WalletProvider> = {}): WalletProvider {
  return {
    getAddress: vi.fn().mockResolvedValue('0xABCD'),
    getNetwork: vi.fn().mockResolvedValue('goat-testnet'),
    getBalance: vi.fn().mockResolvedValue('1000'),
    getErc20Balance: vi.fn().mockResolvedValue('500'),
    transferNative: vi.fn().mockResolvedValue({ txHash: '0xtx' }),
    transferErc20: vi.fn().mockResolvedValue({ txHash: '0xtx' }),
    approveErc20: vi.fn().mockResolvedValue({ txHash: '0xtx' }),
    signTypedData: vi.fn().mockResolvedValue('0xsig'),
    callContract: vi.fn().mockResolvedValue('0x'),
    writeContract: vi.fn().mockResolvedValue({ txHash: '0xtx' }),
    deployContract: vi
      .fn()
      .mockResolvedValue({ txHash: '0xtx_deploy', contractAddress: '0xCONTRACT' }),
    ...overrides,
  };
}

const ctx = { traceId: 't1', network: 'goat-testnet', now: Date.now() };

describe('wallet.deploy_contract', () => {
  it('has correct metadata', () => {
    const wallet = mockWallet();
    const action = deployContractAction(wallet);

    expect(action.name).toBe('wallet.deploy_contract');
    expect(action.riskLevel).toBe('high');
    expect(action.requiresConfirmation).toBe(true);
  });

  it('calls wallet.deployContract with abi, bytecode, and args', async () => {
    const wallet = mockWallet();
    const action = deployContractAction(wallet);

    const result = await action.execute(ctx, {
      abi: ['constructor(uint256)'],
      bytecode: '0x6080',
      args: [42],
    });

    expect(result).toEqual({ txHash: '0xtx_deploy', contractAddress: '0xCONTRACT' });
    expect(wallet.deployContract).toHaveBeenCalledWith(
      ['constructor(uint256)'],
      '0x6080',
      [42],
      undefined,
      { signal: undefined },
    );
  });

  it('passes value for payable constructors', async () => {
    const wallet = mockWallet();
    const action = deployContractAction(wallet);

    await action.execute(ctx, {
      abi: ['constructor() payable'],
      bytecode: '0x6080',
      value: '1000000',
    });

    expect(wallet.deployContract).toHaveBeenCalledWith(
      ['constructor() payable'],
      '0x6080',
      [],
      '1000000',
      { signal: undefined },
    );
  });

  it('defaults args to empty array', async () => {
    const wallet = mockWallet();
    const action = deployContractAction(wallet);

    await action.execute(ctx, {
      abi: ['constructor()'],
      bytecode: '0xabcdef',
    });

    expect(wallet.deployContract).toHaveBeenCalledWith(
      ['constructor()'],
      '0xabcdef',
      [],
      undefined,
      { signal: undefined },
    );
  });
});
