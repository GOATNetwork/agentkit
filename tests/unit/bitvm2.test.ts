import { describe, it, expect, vi } from 'vitest';
import {
  bitvm2RegisterPubkeyAction,
  bitvm2StakeApproveAction,
  bitvm2StakeAction,
  bitvm2LockStakeAction,
  bitvm2PegBtcBalanceAction,
  bitvm2PeginRequestAction,
  bitvm2PegoutInitiateAction,
  STAKE_MANAGEMENT_ADDRESS,
  PEGBTC_ADDRESS,
} from '../../plugins/bitvm2/index';
import type { WalletProvider } from '../../core/wallet/wallet-provider';
import { GoatAdapter } from '../../networks/goat/adapter';

function mockWallet(overrides: Partial<WalletProvider> = {}): WalletProvider {
  return {
    getAddress: vi.fn().mockResolvedValue('0xABCD'),
    getNetwork: vi.fn().mockResolvedValue('goat-testnet'),
    getBalance: vi.fn().mockResolvedValue('1000'),
    getErc20Balance: vi.fn().mockResolvedValue('500'),
    transferNative: vi.fn().mockResolvedValue({ txHash: '0xtx' }),
    transferErc20: vi.fn().mockResolvedValue({ txHash: '0xtx' }),
    approveErc20: vi.fn().mockResolvedValue({ txHash: '0xtx_approve' }),
    signTypedData: vi.fn().mockResolvedValue('0xsig'),
    callContract: vi.fn().mockResolvedValue('0x'),
    writeContract: vi.fn().mockResolvedValue({ txHash: '0xtx_bitvm2' }),
    deployContract: vi.fn().mockResolvedValue({ txHash: '0xtx_deploy', contractAddress: '0xNEW' }),
    ...overrides,
  };
}

const ctx = { traceId: 't1', network: 'goat-testnet', now: Date.now() };

describe('goat.bitvm2.stake.register_pubkey', () => {
  it('has correct metadata', () => {
    const action = bitvm2RegisterPubkeyAction(mockWallet());
    expect(action.name).toBe('goat.bitvm2.stake.register_pubkey');
    expect(action.riskLevel).toBe('high');
    expect(action.requiresConfirmation).toBe(true);
  });

  it('calls writeContract with registerPubkey on StakeManagement', async () => {
    const wallet = mockWallet();
    const action = bitvm2RegisterPubkeyAction(wallet);
    const pubkey = '0x' + 'ab'.repeat(32);

    const result = await action.execute(ctx, { xonlyPubkey: pubkey });
    expect(result).toEqual({ txHash: '0xtx_bitvm2' });
    expect(wallet.writeContract).toHaveBeenCalledWith(
      STAKE_MANAGEMENT_ADDRESS,
      ['function registerPubkey(bytes32 xonlyPubkey)'],
      'registerPubkey',
      [pubkey],
      undefined,
      { signal: undefined },
    );
  });
});

describe('goat.bitvm2.stake.approve', () => {
  it('calls approveErc20 on PegBTC for StakeManagement', async () => {
    const wallet = mockWallet();
    const action = bitvm2StakeApproveAction(wallet);
    expect(action.name).toBe('goat.bitvm2.stake.approve');

    const result = await action.execute(ctx, { amount: '60000000000000000' });
    expect(result).toEqual({ txHash: '0xtx_approve' });
    expect(wallet.approveErc20).toHaveBeenCalledWith(
      PEGBTC_ADDRESS,
      STAKE_MANAGEMENT_ADDRESS,
      '60000000000000000',
      { signal: undefined },
    );
  });
});

describe('goat.bitvm2.stake.stake', () => {
  it('calls writeContract with stake on StakeManagement', async () => {
    const wallet = mockWallet();
    const action = bitvm2StakeAction(wallet);
    expect(action.name).toBe('goat.bitvm2.stake.stake');

    await action.execute(ctx, { amount: '60000000000000000' });
    expect(wallet.writeContract).toHaveBeenCalledWith(
      STAKE_MANAGEMENT_ADDRESS,
      ['function stake(uint256 amount)'],
      'stake',
      [BigInt('60000000000000000')],
      undefined,
      { signal: undefined },
    );
  });
});

describe('goat.bitvm2.stake.lock', () => {
  it('calls writeContract with lockStake on StakeManagement', async () => {
    const wallet = mockWallet();
    const action = bitvm2LockStakeAction(wallet);
    expect(action.name).toBe('goat.bitvm2.stake.lock');

    await action.execute(ctx, { amount: '60000000000000000' });
    expect(wallet.writeContract).toHaveBeenCalledWith(
      STAKE_MANAGEMENT_ADDRESS,
      ['function lockStake(uint256 amount)'],
      'lockStake',
      [BigInt('60000000000000000')],
      undefined,
      { signal: undefined },
    );
  });
});

describe('goat.bitvm2.pegbtc.balance', () => {
  it('returns PegBTC balance for caller address', async () => {
    const wallet = mockWallet({ getErc20Balance: vi.fn().mockResolvedValue('100000000') });
    const action = bitvm2PegBtcBalanceAction(wallet);
    expect(action.name).toBe('goat.bitvm2.pegbtc.balance');
    expect(action.riskLevel).toBe('read');

    const result = await action.execute(ctx, {});
    expect(result).toEqual({ address: '0xABCD', balance: '100000000' });
    expect(wallet.getErc20Balance).toHaveBeenCalledWith(PEGBTC_ADDRESS, '0xABCD');
  });

  it('returns PegBTC balance for specified address', async () => {
    const wallet = mockWallet({ getErc20Balance: vi.fn().mockResolvedValue('200000000') });
    const action = bitvm2PegBtcBalanceAction(wallet);

    const result = await action.execute(ctx, { address: '0x1234' });
    expect(result).toEqual({ address: '0x1234', balance: '200000000' });
    expect(wallet.getErc20Balance).toHaveBeenCalledWith(PEGBTC_ADDRESS, '0x1234');
  });
});

describe('goat.bitvm2.pegin.request', () => {
  it('calls adapter.bitvm2Deposit', async () => {
    const adapter = new GoatAdapter('goat-testnet');
    const action = bitvm2PeginRequestAction(adapter);
    expect(action.name).toBe('goat.bitvm2.pegin.request');
    expect(action.riskLevel).toBe('high');

    const result = await action.execute(ctx, {
      receiverEvmAddress: '0x0000000000000000000000000000000000000001',
      amountSats: '1000000',
    });
    expect(result.bridgeRequestId).toContain('dep_1000000');
    expect(result.status).toBe('CREATED');
  });
});

describe('goat.bitvm2.pegout.initiate', () => {
  it('calls adapter.bitvm2Withdraw', async () => {
    const adapter = new GoatAdapter('goat-testnet');
    const action = bitvm2PegoutInitiateAction(adapter);
    expect(action.name).toBe('goat.bitvm2.pegout.initiate');
    expect(action.riskLevel).toBe('high');

    const result = await action.execute(ctx, {
      fromGoatAddress: '0x0000000000000000000000000000000000000001',
      toBtcAddress: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
      amountSats: '500000',
    });
    expect(result.bridgeRequestId).toContain('wd_500000');
    expect(result.status).toBe('CREATED');
  });
});
