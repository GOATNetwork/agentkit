import { describe, it, expect, vi } from 'vitest';
import {
  bitcoinBlockHashAction,
  bitcoinLatestHeightAction,
  bitcoinNetworkNameAction,
  BITCOIN_ADDRESS,
} from '../../plugins/bitcoin/index';
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
    deployContract: vi.fn().mockResolvedValue({ txHash: '0xtx_deploy', contractAddress: '0xNEW' }),
    ...overrides,
  };
}

const ctx = { traceId: 't1', network: 'goat-testnet', now: Date.now() };

describe('bitcoin.block_hash', () => {
  it('calls callContract with blockHash', async () => {
    const wallet = mockWallet({
      callContract: vi.fn().mockResolvedValue('0xblockhash123'),
    });
    const action = bitcoinBlockHashAction(wallet);

    expect(action.name).toBe('bitcoin.block_hash');
    expect(action.riskLevel).toBe('read');
    expect(action.requiresConfirmation).toBe(false);

    const result = await action.execute(ctx, { height: 800000 });
    expect(result).toEqual({ height: 800000, blockHash: '0xblockhash123' });
    expect(wallet.callContract).toHaveBeenCalledWith(
      BITCOIN_ADDRESS,
      ['function blockHash(uint256) view returns (bytes32)'],
      'blockHash',
      [800000],
    );
  });
});

describe('bitcoin.latest_height', () => {
  it('calls callContract with latestHeight', async () => {
    const wallet = mockWallet({
      callContract: vi.fn().mockResolvedValue(BigInt(850000)),
    });
    const action = bitcoinLatestHeightAction(wallet);

    expect(action.name).toBe('bitcoin.latest_height');
    expect(action.riskLevel).toBe('read');
    expect(action.requiresConfirmation).toBe(false);

    const result = await action.execute(ctx, {});
    expect(result).toEqual({ height: '850000' });
    expect(wallet.callContract).toHaveBeenCalledWith(
      BITCOIN_ADDRESS,
      ['function latestHeight() view returns (uint256)'],
      'latestHeight',
      [],
    );
  });
});

describe('bitcoin.network_name', () => {
  it('calls callContract with networkName', async () => {
    const wallet = mockWallet({
      callContract: vi.fn().mockResolvedValue('mainnet'),
    });
    const action = bitcoinNetworkNameAction(wallet);

    expect(action.name).toBe('bitcoin.network_name');
    expect(action.riskLevel).toBe('read');
    expect(action.requiresConfirmation).toBe(false);

    const result = await action.execute(ctx, {});
    expect(result).toEqual({ networkName: 'mainnet' });
    expect(wallet.callContract).toHaveBeenCalledWith(
      BITCOIN_ADDRESS,
      ['function networkName() view returns (string)'],
      'networkName',
      [],
    );
  });
});
