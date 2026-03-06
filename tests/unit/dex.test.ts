import { describe, it, expect, vi } from 'vitest';
import {
  dexQuoteAction,
  dexSwapAction,
  dexGetPoolAction,
  dexAddLiquidityAction,
  dexRemoveLiquidityAction,
  dexCollectFeesAction,
  dexGetPositionAction,
  SWAP_ROUTER_ADDRESS,
  QUOTER_V2_ADDRESS,
  POSITION_MANAGER_ADDRESS,
  V3_FACTORY_ADDRESS,
} from '../../plugins/dex/index';
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
    writeContract: vi.fn().mockResolvedValue({ txHash: '0xtx_dex' }),
    deployContract: vi.fn().mockResolvedValue({ txHash: '0xtx_deploy', contractAddress: '0xNEW' }),
    ...overrides,
  };
}

const ctx = { traceId: 't1', network: 'goat-mainnet', now: Date.now() };

describe('dex.quote', () => {
  it('calls callContract on QuoterV2 with quoteExactInputSingle', async () => {
    const mockResult = [BigInt(500000), BigInt(7922816251426434), 100, BigInt(21000)];
    const wallet = mockWallet({ callContract: vi.fn().mockResolvedValue(mockResult) });
    const action = dexQuoteAction(wallet);

    expect(action.name).toBe('dex.quote');
    expect(action.riskLevel).toBe('read');
    expect(action.requiresConfirmation).toBe(false);

    const result = await action.execute(ctx, {
      tokenIn: '0x0000000000000000000000000000000000000001',
      tokenOut: '0x0000000000000000000000000000000000000002',
      fee: 3000,
      amountIn: '1000000',
    });

    expect(result).toEqual({
      amountOut: '500000',
      sqrtPriceX96After: '7922816251426434',
      gasEstimate: '21000',
    });
    expect(wallet.callContract).toHaveBeenCalledWith(
      QUOTER_V2_ADDRESS,
      ['function quoteExactInputSingle((address,address,uint256,uint24,uint160)) returns (uint256,uint160,uint32,uint256)'],
      'quoteExactInputSingle',
      [['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002', BigInt('1000000'), 3000, 0]],
    );
  });
});

describe('dex.swap', () => {
  it('calls writeContract on SwapRouter02 with exactInputSingle', async () => {
    const wallet = mockWallet();
    const action = dexSwapAction(wallet);

    expect(action.name).toBe('dex.swap');
    expect(action.riskLevel).toBe('high');
    expect(action.requiresConfirmation).toBe(true);

    const result = await action.execute(ctx, {
      tokenIn: '0x0000000000000000000000000000000000000001',
      tokenOut: '0x0000000000000000000000000000000000000002',
      fee: 3000,
      amountIn: '1000000',
      amountOutMinimum: '490000',
    });

    expect(result).toEqual({ txHash: '0xtx_dex' });
    expect(wallet.writeContract).toHaveBeenCalledWith(
      SWAP_ROUTER_ADDRESS,
      ['function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) payable returns (uint256)'],
      'exactInputSingle',
      [['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002', 3000, '0xABCD', BigInt('1000000'), BigInt('490000'), 0]],
      undefined,
      { signal: undefined },
    );
  });

  it('passes value for payable swap', async () => {
    const wallet = mockWallet();
    const action = dexSwapAction(wallet);

    await action.execute(ctx, {
      tokenIn: '0x0000000000000000000000000000000000000001',
      tokenOut: '0x0000000000000000000000000000000000000002',
      fee: 3000,
      amountIn: '1000000',
      amountOutMinimum: '490000',
      value: '1000000',
    });

    expect(wallet.writeContract).toHaveBeenCalledWith(
      SWAP_ROUTER_ADDRESS,
      expect.any(Array),
      'exactInputSingle',
      expect.any(Array),
      '1000000',
      { signal: undefined },
    );
  });
});

describe('dex.get_pool', () => {
  it('calls callContract on V3Factory with getPool', async () => {
    const poolAddr = '0x1234567890abcdef1234567890abcdef12345678';
    const wallet = mockWallet({ callContract: vi.fn().mockResolvedValue(poolAddr) });
    const action = dexGetPoolAction(wallet);

    expect(action.name).toBe('dex.get_pool');
    expect(action.riskLevel).toBe('read');
    expect(action.requiresConfirmation).toBe(false);

    const result = await action.execute(ctx, {
      tokenA: '0x0000000000000000000000000000000000000001',
      tokenB: '0x0000000000000000000000000000000000000002',
      fee: 3000,
    });

    expect(result).toEqual({ pool: poolAddr });
    expect(wallet.callContract).toHaveBeenCalledWith(
      V3_FACTORY_ADDRESS,
      ['function getPool(address,address,uint24) view returns (address)'],
      'getPool',
      ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002', 3000],
    );
  });
});

describe('dex.add_liquidity', () => {
  it('calls writeContract on PositionManager with mint', async () => {
    const wallet = mockWallet();
    const action = dexAddLiquidityAction(wallet);

    expect(action.name).toBe('dex.add_liquidity');
    expect(action.riskLevel).toBe('high');
    expect(action.requiresConfirmation).toBe(true);

    const result = await action.execute(ctx, {
      token0: '0x0000000000000000000000000000000000000001',
      token1: '0x0000000000000000000000000000000000000002',
      fee: 3000,
      tickLower: -887220,
      tickUpper: 887220,
      amount0Desired: '1000000',
      amount1Desired: '2000000',
      amount0Min: '900000',
      amount1Min: '1800000',
      deadline: '1700000000',
    });

    expect(result).toEqual({ txHash: '0xtx_dex' });
    expect(wallet.writeContract).toHaveBeenCalledWith(
      POSITION_MANAGER_ADDRESS,
      ['function mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256)) payable returns (uint256,uint128,uint256,uint256)'],
      'mint',
      [[
        '0x0000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000002',
        3000,
        -887220,
        887220,
        BigInt('1000000'),
        BigInt('2000000'),
        BigInt('900000'),
        BigInt('1800000'),
        '0xABCD',
        BigInt('1700000000'),
      ]],
      undefined,
      { signal: undefined },
    );
  });
});

describe('dex.remove_liquidity', () => {
  it('calls writeContract on PositionManager with decreaseLiquidity', async () => {
    const wallet = mockWallet();
    const action = dexRemoveLiquidityAction(wallet);

    expect(action.name).toBe('dex.remove_liquidity');
    expect(action.riskLevel).toBe('high');
    expect(action.requiresConfirmation).toBe(true);

    const result = await action.execute(ctx, {
      tokenId: '42',
      liquidity: '500000',
      amount0Min: '400000',
      amount1Min: '800000',
      deadline: '1700000000',
    });

    expect(result).toEqual({ txHash: '0xtx_dex' });
    expect(wallet.writeContract).toHaveBeenCalledWith(
      POSITION_MANAGER_ADDRESS,
      ['function decreaseLiquidity((uint256,uint128,uint256,uint256,uint256)) returns (uint256,uint256)'],
      'decreaseLiquidity',
      [[BigInt('42'), BigInt('500000'), BigInt('400000'), BigInt('800000'), BigInt('1700000000')]],
      undefined,
      { signal: undefined },
    );
  });
});

describe('dex.collect_fees', () => {
  it('calls writeContract on PositionManager with collect', async () => {
    const wallet = mockWallet();
    const action = dexCollectFeesAction(wallet);

    expect(action.name).toBe('dex.collect_fees');
    expect(action.riskLevel).toBe('medium');
    expect(action.requiresConfirmation).toBe(true);

    const result = await action.execute(ctx, {
      tokenId: '42',
      amount0Max: '999999999',
      amount1Max: '999999999',
    });

    expect(result).toEqual({ txHash: '0xtx_dex' });
    expect(wallet.writeContract).toHaveBeenCalledWith(
      POSITION_MANAGER_ADDRESS,
      ['function collect((uint256,address,uint128,uint128)) returns (uint256,uint256)'],
      'collect',
      [[BigInt('42'), '0xABCD', BigInt('999999999'), BigInt('999999999')]],
      undefined,
      { signal: undefined },
    );
  });
});

describe('dex.get_position', () => {
  it('calls callContract on PositionManager with positions and parses tuple', async () => {
    const mockTuple = [
      BigInt(0),
      '0xOPERATOR',
      '0xTOKEN0',
      '0xTOKEN1',
      3000,
      -887220,
      887220,
      BigInt(1000000),
      BigInt(123456789),
      BigInt(987654321),
      BigInt(5000),
      BigInt(3000),
    ];
    const wallet = mockWallet({ callContract: vi.fn().mockResolvedValue(mockTuple) });
    const action = dexGetPositionAction(wallet);

    expect(action.name).toBe('dex.get_position');
    expect(action.riskLevel).toBe('read');
    expect(action.requiresConfirmation).toBe(false);

    const result = await action.execute(ctx, { tokenId: '42' });

    expect(result).toEqual({
      tokenId: '42',
      nonce: '0',
      operator: '0xOPERATOR',
      token0: '0xTOKEN0',
      token1: '0xTOKEN1',
      fee: 3000,
      tickLower: -887220,
      tickUpper: 887220,
      liquidity: '1000000',
      feeGrowthInside0LastX128: '123456789',
      feeGrowthInside1LastX128: '987654321',
      tokensOwed0: '5000',
      tokensOwed1: '3000',
    });
    expect(wallet.callContract).toHaveBeenCalledWith(
      POSITION_MANAGER_ADDRESS,
      ['function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)'],
      'positions',
      [BigInt('42')],
    );
  });
});
