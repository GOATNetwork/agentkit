import { describe, it, expect, vi } from 'vitest';
import {
  bridgeWithdrawAction,
  bridgeCancelAction,
  bridgeRefundAction,
  bridgeReplaceByFeeAction,
  bridgeDepositStatusAction,
  bridgeWithdrawalStatusAction,
  bridgeGetParamsAction,
  BRIDGE_ADDRESS,
} from '../../plugins/bridge/index';
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
    writeContract: vi.fn().mockResolvedValue({ txHash: '0xtx_bridge' }),
    deployContract: vi.fn().mockResolvedValue({ txHash: '0xtx_deploy', contractAddress: '0xNEW' }),
    ...overrides,
  };
}

const ctx = { traceId: 't1', network: 'goat-testnet', now: Date.now() };

describe('bridge.withdraw', () => {
  it('calls writeContract with value for payable withdraw', async () => {
    const wallet = mockWallet();
    const action = bridgeWithdrawAction(wallet);

    expect(action.name).toBe('bridge.withdraw');
    expect(action.riskLevel).toBe('high');
    expect(action.requiresConfirmation).toBe(true);

    const result = await action.execute(ctx, {
      receiver: 'bc1qexample',
      amountWei: '10000000000',
      maxTxPrice: 50,
    });
    expect(result).toEqual({ txHash: '0xtx_bridge' });
    expect(wallet.writeContract).toHaveBeenCalledWith(
      BRIDGE_ADDRESS,
      ['function withdraw(string,uint16) payable'],
      'withdraw',
      ['bc1qexample', 50],
      '10000000000',
      { signal: undefined },
    );
  });
});

describe('bridge.cancel', () => {
  it('calls writeContract with cancel1', async () => {
    const wallet = mockWallet();
    const action = bridgeCancelAction(wallet);

    expect(action.name).toBe('bridge.cancel');
    expect(action.riskLevel).toBe('medium');
    expect(action.requiresConfirmation).toBe(true);

    const result = await action.execute(ctx, { withdrawalId: 42 });
    expect(result).toEqual({ txHash: '0xtx_bridge' });
    expect(wallet.writeContract).toHaveBeenCalledWith(
      BRIDGE_ADDRESS,
      ['function cancel1(uint256)'],
      'cancel1',
      [42],
      undefined,
      { signal: undefined },
    );
  });
});

describe('bridge.refund', () => {
  it('calls writeContract with refund', async () => {
    const wallet = mockWallet();
    const action = bridgeRefundAction(wallet);

    expect(action.name).toBe('bridge.refund');
    expect(action.riskLevel).toBe('medium');
    expect(action.requiresConfirmation).toBe(true);

    const result = await action.execute(ctx, { withdrawalId: 7 });
    expect(result).toEqual({ txHash: '0xtx_bridge' });
    expect(wallet.writeContract).toHaveBeenCalledWith(
      BRIDGE_ADDRESS,
      ['function refund(uint256)'],
      'refund',
      [7],
      undefined,
      { signal: undefined },
    );
  });
});

describe('bridge.replace_by_fee', () => {
  it('calls writeContract with replaceByFee', async () => {
    const wallet = mockWallet();
    const action = bridgeReplaceByFeeAction(wallet);

    expect(action.name).toBe('bridge.replace_by_fee');
    expect(action.riskLevel).toBe('medium');
    expect(action.requiresConfirmation).toBe(true);

    const result = await action.execute(ctx, { withdrawalId: 3, maxTxPrice: 100 });
    expect(result).toEqual({ txHash: '0xtx_bridge' });
    expect(wallet.writeContract).toHaveBeenCalledWith(
      BRIDGE_ADDRESS,
      ['function replaceByFee(uint256,uint16)'],
      'replaceByFee',
      [3, 100],
      undefined,
      { signal: undefined },
    );
  });
});

describe('bridge.deposit_status', () => {
  it('calls callContract with isDeposited', async () => {
    const wallet = mockWallet({ callContract: vi.fn().mockResolvedValue(true) });
    const action = bridgeDepositStatusAction(wallet);

    expect(action.name).toBe('bridge.deposit_status');
    expect(action.riskLevel).toBe('read');
    expect(action.requiresConfirmation).toBe(false);

    const result = await action.execute(ctx, { txHash: '0xabc', txout: 0 });
    expect(result).toEqual({ txHash: '0xabc', txout: 0, deposited: true });
    expect(wallet.callContract).toHaveBeenCalledWith(
      BRIDGE_ADDRESS,
      ['function isDeposited(bytes32,uint32) view returns (bool)'],
      'isDeposited',
      ['0xabc', 0],
    );
  });
});

describe('bridge.withdrawal_status', () => {
  it('calls callContract with withdrawals and parses tuple', async () => {
    const mockTuple = ['0xSENDER', 50, 1, BigInt(1000), BigInt(10), BigInt(1700000000)];
    const wallet = mockWallet({ callContract: vi.fn().mockResolvedValue(mockTuple) });
    const action = bridgeWithdrawalStatusAction(wallet);

    expect(action.name).toBe('bridge.withdrawal_status');
    expect(action.riskLevel).toBe('read');

    const result = await action.execute(ctx, { withdrawalId: 5 });
    expect(result).toEqual({
      withdrawalId: 5,
      sender: '0xSENDER',
      maxTxPrice: 50,
      status: 1,
      amount: '1000',
      tax: '10',
      updatedAt: '1700000000',
    });
  });
});

describe('bridge.get_params', () => {
  it('calls both depositParam and withdrawParam', async () => {
    const callContract = vi
      .fn()
      .mockResolvedValueOnce([BigInt(100), BigInt(200)])
      .mockResolvedValueOnce([BigInt(300), BigInt(400), 10, 20, 30]);
    const wallet = mockWallet({ callContract });
    const action = bridgeGetParamsAction(wallet);

    expect(action.name).toBe('bridge.get_params');
    expect(action.riskLevel).toBe('read');

    const result = await action.execute(ctx, {});
    expect(result.depositParam).toEqual([BigInt(100), BigInt(200)]);
    expect(result.withdrawParam).toEqual([BigInt(300), BigInt(400), 10, 20, 30]);
    expect(callContract).toHaveBeenCalledTimes(2);
  });
});
