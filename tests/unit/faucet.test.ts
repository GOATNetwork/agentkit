import { describe, it, expect } from 'vitest';
import { faucetRequestFundsAction, faucetGetChainsAction, NoopFaucetAdapter } from '../../plugins/faucet/index';

const ctx = { traceId: 't1', network: 'goat-testnet', now: Date.now() };

describe('faucet.request_funds', () => {
  it('calls adapter requestFunds', async () => {
    const adapter = new NoopFaucetAdapter();
    const action = faucetRequestFundsAction(adapter);

    expect(action.name).toBe('faucet.request_funds');
    expect(action.riskLevel).toBe('low');
    expect(action.requiresConfirmation).toBe(false);
    expect(action.networks).toEqual(['goat-testnet']);

    const result = await action.execute(ctx, { chain: 'goat-testnet', address: '0xABCD' });
    expect(result.success).toBe(true);
    expect(result.txHash).toBeDefined();
  });

  it('passes tokenAddress when provided', async () => {
    const adapter = new NoopFaucetAdapter();
    const action = faucetRequestFundsAction(adapter);

    const result = await action.execute(ctx, {
      chain: 'goat-testnet',
      address: '0xABCD',
      tokenAddress: '0xTOKEN',
    });
    expect(result.success).toBe(true);
  });
});

describe('faucet.get_chains', () => {
  it('calls adapter getChains', async () => {
    const adapter = new NoopFaucetAdapter();
    const action = faucetGetChainsAction(adapter);

    expect(action.name).toBe('faucet.get_chains');
    expect(action.riskLevel).toBe('read');
    expect(action.requiresConfirmation).toBe(false);
    expect(action.networks).toEqual(['goat-testnet']);

    const result = await action.execute(ctx, {});
    expect(result).toEqual({ chains: ['goat-testnet'] });
  });
});
