import { describe, it, expect, vi } from 'vitest';
import {
  oftQuoteSendAction,
  oftSendAction,
  oftQuoteOftAction,
} from '../../plugins/layerzero/index';
import type { WalletProvider } from '../../core/wallet/wallet-provider';

function mockWallet(overrides: Partial<WalletProvider> = {}): WalletProvider {
  return {
    getAddress: vi.fn().mockResolvedValue('0xABCD'),
    getNetwork: vi.fn().mockResolvedValue('goat-mainnet'),
    getBalance: vi.fn().mockResolvedValue('1000'),
    getErc20Balance: vi.fn().mockResolvedValue('500'),
    transferNative: vi.fn().mockResolvedValue({ txHash: '0xtx' }),
    transferErc20: vi.fn().mockResolvedValue({ txHash: '0xtx' }),
    approveErc20: vi.fn().mockResolvedValue({ txHash: '0xtx' }),
    signTypedData: vi.fn().mockResolvedValue('0xsig'),
    callContract: vi.fn().mockResolvedValue('0x'),
    writeContract: vi.fn().mockResolvedValue({ txHash: '0xtx_lz' }),
    deployContract: vi.fn().mockResolvedValue({ txHash: '0xtx_deploy', contractAddress: '0xNEW' }),
    ...overrides,
  };
}

const ctx = { traceId: 't1', network: 'goat-mainnet', now: Date.now() };
const OFT_ADDR = '0x1234567890abcdef1234567890abcdef12345678';
const BYTES32_TO = '0x000000000000000000000000abcdefabcdefabcdefabcdefabcdefabcdefabcd';

describe('oft.quote_send', () => {
  it('calls callContract with quoteSend and returns fees', async () => {
    const mockResult = [BigInt(50000000000000), BigInt(0)];
    const wallet = mockWallet({ callContract: vi.fn().mockResolvedValue(mockResult) });
    const action = oftQuoteSendAction(wallet);

    expect(action.name).toBe('oft.quote_send');
    expect(action.riskLevel).toBe('read');
    expect(action.requiresConfirmation).toBe(false);

    const result = await action.execute(ctx, {
      oftAddress: OFT_ADDR,
      dstEid: 30111,
      to: BYTES32_TO,
      amountLD: '1000000',
      minAmountLD: '900000',
      extraOptions: '0x',
      composeMsg: '0x',
      oftCmd: '0x',
      payInLzToken: false,
    });

    expect(result).toEqual({
      nativeFee: '50000000000000',
      lzTokenFee: '0',
    });
    expect(wallet.callContract).toHaveBeenCalledWith(
      OFT_ADDR,
      ['function quoteSend((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),bool) view returns (uint256,uint256)'],
      'quoteSend',
      [
        [30111, BYTES32_TO, BigInt('1000000'), BigInt('900000'), '0x', '0x', '0x'],
        false,
      ],
    );
  });
});

describe('oft.send', () => {
  it('calls writeContract with send and passes nativeFee as value', async () => {
    const wallet = mockWallet();
    const action = oftSendAction(wallet);

    expect(action.name).toBe('oft.send');
    expect(action.riskLevel).toBe('high');
    expect(action.requiresConfirmation).toBe(true);

    const result = await action.execute(ctx, {
      oftAddress: OFT_ADDR,
      dstEid: 30111,
      to: BYTES32_TO,
      amountLD: '1000000',
      minAmountLD: '900000',
      extraOptions: '0x',
      composeMsg: '0x',
      oftCmd: '0x',
      nativeFee: '50000000000000',
      lzTokenFee: '0',
    });

    expect(result).toEqual({ txHash: '0xtx_lz' });
    expect(wallet.writeContract).toHaveBeenCalledWith(
      OFT_ADDR,
      ['function send((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),(uint256,uint256),address) payable returns ((bytes32,uint64,uint256,uint256),(uint256,uint256))'],
      'send',
      [
        [30111, BYTES32_TO, BigInt('1000000'), BigInt('900000'), '0x', '0x', '0x'],
        [BigInt('50000000000000'), BigInt('0')],
        '0xABCD',
      ],
      '50000000000000',
      { signal: undefined },
    );
  });

  it('uses custom refundAddress when provided', async () => {
    const wallet = mockWallet();
    const action = oftSendAction(wallet);

    await action.execute(ctx, {
      oftAddress: OFT_ADDR,
      dstEid: 30111,
      to: BYTES32_TO,
      amountLD: '1000000',
      minAmountLD: '900000',
      extraOptions: '0x',
      composeMsg: '0x',
      oftCmd: '0x',
      nativeFee: '50000000000000',
      lzTokenFee: '0',
      refundAddress: '0x9999999999999999999999999999999999999999',
    });

    expect(wallet.writeContract).toHaveBeenCalledWith(
      OFT_ADDR,
      expect.any(Array),
      'send',
      expect.arrayContaining([
        expect.anything(),
        expect.anything(),
        '0x9999999999999999999999999999999999999999',
      ]),
      '50000000000000',
      { signal: undefined },
    );
    expect(wallet.getAddress).not.toHaveBeenCalled();
  });
});

describe('oft.quote_oft', () => {
  it('calls callContract with quoteOFT and parses limits and receipt', async () => {
    const mockResult = [
      [BigInt(100), BigInt(1000000000)],
      [],
      [BigInt(1000000), BigInt(950000)],
    ];
    const wallet = mockWallet({ callContract: vi.fn().mockResolvedValue(mockResult) });
    const action = oftQuoteOftAction(wallet);

    expect(action.name).toBe('oft.quote_oft');
    expect(action.riskLevel).toBe('read');
    expect(action.requiresConfirmation).toBe(false);

    const result = await action.execute(ctx, {
      oftAddress: OFT_ADDR,
      dstEid: 30111,
      to: BYTES32_TO,
      amountLD: '1000000',
      minAmountLD: '900000',
      extraOptions: '0x',
      composeMsg: '0x',
      oftCmd: '0x',
    });

    expect(result).toEqual({
      minAmountLD: '100',
      maxAmountLD: '1000000000',
      amountSentLD: '1000000',
      amountReceivedLD: '950000',
    });
    expect(wallet.callContract).toHaveBeenCalledWith(
      OFT_ADDR,
      ['function quoteOFT((uint32,bytes32,uint256,uint256,bytes,bytes,bytes)) view returns ((uint256,uint256),(uint256,uint256)[],(uint256,uint256))'],
      'quoteOFT',
      [
        [30111, BYTES32_TO, BigInt('1000000'), BigInt('900000'), '0x', '0x', '0x'],
      ],
    );
  });
});
