import { describe, it, expect } from 'vitest';
import { resolveTokenAction } from '../../plugins/wallet/index';
import { GOAT_TOKENS, resolveTokenAddress } from '../../networks/goat/tokens';

const ctx = { traceId: 't1', network: 'goat-testnet', now: Date.now() };

describe('wallet.resolve_token', () => {
  it('has correct metadata', () => {
    const action = resolveTokenAction();

    expect(action.name).toBe('wallet.resolve_token');
    expect(action.riskLevel).toBe('read');
    expect(action.requiresConfirmation).toBe(false);
  });

  it('resolves WGBTC symbol', async () => {
    const action = resolveTokenAction();
    const result = await action.execute(ctx, { symbol: 'WGBTC' });

    expect(result).toEqual({
      symbol: 'WGBTC',
      address: '0xBC10000000000000000000000000000000000000',
    });
  });

  it('resolves case-insensitively', async () => {
    const action = resolveTokenAction();
    const result = await action.execute(ctx, { symbol: 'goat' });

    expect(result).toEqual({
      symbol: 'GOAT',
      address: '0xbC10000000000000000000000000000000000001',
    });
  });

  it('throws on unknown symbol', async () => {
    const action = resolveTokenAction();

    await expect(action.execute(ctx, { symbol: 'UNKNOWN' })).rejects.toThrow(
      /Unknown token symbol/,
    );
  });
});

describe('resolveTokenAddress', () => {
  it('returns entry for known symbol', () => {
    const entry = resolveTokenAddress('BRIDGE');
    expect(entry.address).toBe(GOAT_TOKENS.BRIDGE.address);
  });

  it('throws with known symbols listed', () => {
    expect(() => resolveTokenAddress('FOO')).toThrow(/WGBTC, GOAT, BRIDGE, BITCOIN/);
  });
});
