import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { customActionProvider } from '../../providers/custom-action-provider';

describe('customActionProvider', () => {
  it('registers actions and applies defaults', () => {
    const provider = customActionProvider([
      {
        name: 'my.action',
        description: 'A custom action',
        schema: z.object({ x: z.number() }),
        invoke: async (input: any) => ({ doubled: input.x * 2 }),
      },
    ]);

    const action = provider.get('my.action');
    expect(action.name).toBe('my.action');
    expect(action.riskLevel).toBe('low');
    expect(action.requiresConfirmation).toBe(false);
    expect(action.networks).toEqual([]);
  });

  it('respects explicit riskLevel and networks', () => {
    const provider = customActionProvider([
      {
        name: 'risky.action',
        description: 'High risk',
        schema: z.object({}),
        invoke: async () => ({}),
        riskLevel: 'high',
        requiresConfirmation: true,
        networks: ['goat-mainnet'],
      },
    ]);

    const action = provider.get('risky.action');
    expect(action.riskLevel).toBe('high');
    expect(action.requiresConfirmation).toBe(true);
    expect(action.networks).toEqual(['goat-mainnet']);
  });

  it('filters actions by network', () => {
    const provider = customActionProvider([
      {
        name: 'net.a',
        description: 'Only mainnet',
        schema: z.object({}),
        invoke: async () => ({}),
        networks: ['goat-mainnet'],
      },
      {
        name: 'net.b',
        description: 'Only testnet',
        schema: z.object({}),
        invoke: async () => ({}),
        networks: ['goat-testnet'],
      },
      {
        name: 'net.c',
        description: 'All networks (empty)',
        schema: z.object({}),
        invoke: async () => ({}),
      },
    ]);

    const mainnet = provider.listForNetwork('goat-mainnet');
    expect(mainnet.map((a) => a.name)).toEqual(['net.a', 'net.c']);

    const testnet = provider.listForNetwork('goat-testnet');
    expect(testnet.map((a) => a.name)).toEqual(['net.b', 'net.c']);
  });

  it('executes action invoke function', async () => {
    const provider = customActionProvider([
      {
        name: 'math.double',
        description: 'Doubles a number',
        schema: z.object({ x: z.number() }),
        invoke: async (input: any) => ({ result: input.x * 2 }),
      },
    ]);

    const action = provider.get('math.double');
    const output = await action.execute({ traceId: 't1', network: 'goat-testnet', now: Date.now() }, { x: 5 });
    expect(output).toEqual({ result: 10 });
  });
});
