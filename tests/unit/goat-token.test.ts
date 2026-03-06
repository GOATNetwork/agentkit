import { describe, it, expect, vi } from 'vitest';
import {
  goatTokenDelegateAction,
  goatTokenGetVotesAction,
  goatTokenGetDelegatesAction,
  GOAT_TOKEN_ADDRESS,
} from '../../plugins/goat-token/index';
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
    callContract: vi.fn().mockResolvedValue('42'),
    writeContract: vi.fn().mockResolvedValue({ txHash: '0xtx_delegate' }),
    deployContract: vi.fn().mockResolvedValue({ txHash: '0xtx_deploy', contractAddress: '0xNEW' }),
    ...overrides,
  };
}

const ctx = { traceId: 't1', network: 'goat-testnet', now: Date.now() };

describe('goat_token.delegate', () => {
  it('calls writeContract with delegate on GoatToken address', async () => {
    const wallet = mockWallet();
    const action = goatTokenDelegateAction(wallet);

    expect(action.name).toBe('goat_token.delegate');
    expect(action.riskLevel).toBe('medium');
    expect(action.requiresConfirmation).toBe(true);

    const result = await action.execute(ctx, { delegatee: '0x1234' });
    expect(result).toEqual({ txHash: '0xtx_delegate' });
    expect(wallet.writeContract).toHaveBeenCalledWith(
      GOAT_TOKEN_ADDRESS,
      ['function delegate(address)'],
      'delegate',
      ['0x1234'],
      undefined,
      { signal: undefined },
    );
  });
});

describe('goat_token.get_votes', () => {
  it('calls callContract with getVotes on GoatToken address', async () => {
    const wallet = mockWallet({ callContract: vi.fn().mockResolvedValue(BigInt(100)) });
    const action = goatTokenGetVotesAction(wallet);

    expect(action.name).toBe('goat_token.get_votes');
    expect(action.riskLevel).toBe('read');
    expect(action.requiresConfirmation).toBe(false);

    const result = await action.execute(ctx, { address: '0x1234' });
    expect(result).toEqual({ address: '0x1234', votes: '100' });
    expect(wallet.callContract).toHaveBeenCalledWith(
      GOAT_TOKEN_ADDRESS,
      ['function getVotes(address) view returns (uint256)'],
      'getVotes',
      ['0x1234'],
    );
  });
});

describe('goat_token.get_delegates', () => {
  it('calls callContract with delegates on GoatToken address', async () => {
    const wallet = mockWallet({ callContract: vi.fn().mockResolvedValue('0xDELEGATEE') });
    const action = goatTokenGetDelegatesAction(wallet);

    expect(action.name).toBe('goat_token.get_delegates');
    expect(action.riskLevel).toBe('read');
    expect(action.requiresConfirmation).toBe(false);

    const result = await action.execute(ctx, { address: '0x1234' });
    expect(result).toEqual({ address: '0x1234', delegatee: '0xDELEGATEE' });
    expect(wallet.callContract).toHaveBeenCalledWith(
      GOAT_TOKEN_ADDRESS,
      ['function delegates(address) view returns (address)'],
      'delegates',
      ['0x1234'],
    );
  });
});
