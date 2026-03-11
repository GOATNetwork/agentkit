import { describe, it, expect, vi } from 'vitest';
import { wgbtcWrapAction, wgbtcUnwrapAction, wgbtcBalanceAction, WGBTC_ADDRESS } from '../../plugins/wgbtc/index';
import type { WalletProvider } from '../../core/wallet/wallet-provider';

function mockWallet(overrides: Partial<WalletProvider> = {}): WalletProvider {
  return {
    getAddress: vi.fn().mockResolvedValue('0xABCD'),
    getNetwork: vi.fn().mockResolvedValue('goat-testnet'),
    getBalance: vi.fn().mockResolvedValue('1000'),
    getErc20Balance: vi.fn().mockResolvedValue('500'),
    transferNative: vi.fn().mockResolvedValue({ txHash: '0xtx_wrap' }),
    transferErc20: vi.fn().mockResolvedValue({ txHash: '0xtx' }),
    approveErc20: vi.fn().mockResolvedValue({ txHash: '0xtx' }),
    signTypedData: vi.fn().mockResolvedValue('0xsig'),
    callContract: vi.fn().mockResolvedValue('42'),
    writeContract: vi.fn().mockResolvedValue({ txHash: '0xtx_unwrap' }),
    deployContract: vi.fn().mockResolvedValue({ txHash: '0xtx_deploy', contractAddress: '0xNEW' }),
    ...overrides,
  };
}

const ctx = { traceId: 't1', network: 'goat-testnet', now: Date.now() };

describe('wgbtc.wrap', () => {
  it('calls transferNative to WGBTC address', async () => {
    const wallet = mockWallet();
    const action = wgbtcWrapAction(wallet);

    expect(action.name).toBe('wgbtc.wrap');
    expect(action.riskLevel).toBe('high');
    expect(action.requiresConfirmation).toBe(true);

    const result = await action.execute(ctx, { amountWei: '1000000' });
    expect(result).toEqual({ txHash: '0xtx_wrap' });
    expect(wallet.transferNative).toHaveBeenCalledWith(WGBTC_ADDRESS, '1000000', { signal: undefined });
  });
});

describe('wgbtc.unwrap', () => {
  it('calls writeContract with withdraw on WGBTC address', async () => {
    const wallet = mockWallet();
    const action = wgbtcUnwrapAction(wallet);

    expect(action.name).toBe('wgbtc.unwrap');
    expect(action.riskLevel).toBe('high');
    expect(action.requiresConfirmation).toBe(true);

    const result = await action.execute(ctx, { amountWei: '500000' });
    expect(result).toEqual({ txHash: '0xtx_unwrap' });
    expect(wallet.writeContract).toHaveBeenCalledWith(
      WGBTC_ADDRESS,
      ['function withdraw(uint256)'],
      'withdraw',
      ['500000'],
      undefined,
      { signal: undefined },
    );
  });
});

describe('wgbtc.balance', () => {
  it('calls getErc20Balance with WGBTC address', async () => {
    const wallet = mockWallet();
    const action = wgbtcBalanceAction(wallet);

    expect(action.name).toBe('wgbtc.balance');
    expect(action.riskLevel).toBe('read');
    expect(action.requiresConfirmation).toBe(false);

    const result = await action.execute(ctx, { address: '0x1234' });
    expect(result).toEqual({ tokenAddress: WGBTC_ADDRESS, balance: '500' });
    expect(wallet.getErc20Balance).toHaveBeenCalledWith(WGBTC_ADDRESS, '0x1234');
  });

  it('works without explicit address', async () => {
    const wallet = mockWallet();
    const action = wgbtcBalanceAction(wallet);

    await action.execute(ctx, {});
    expect(wallet.getErc20Balance).toHaveBeenCalledWith(WGBTC_ADDRESS, undefined);
  });
});
