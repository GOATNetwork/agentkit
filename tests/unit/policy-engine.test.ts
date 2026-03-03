import { describe, it, expect } from 'vitest';
import { PolicyEngine } from '../../core/policy/policy-engine';
import type { ActionDefinition, ActionContext } from '../../core/schema/action';

function makeAction(overrides: Partial<ActionDefinition> = {}): ActionDefinition {
  return {
    name: 'test.action',
    description: 'test',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-testnet'],
    async execute() { return {}; },
    ...overrides,
  };
}

const ctx: ActionContext = { traceId: 't1', network: 'goat-testnet', now: Date.now() };

describe('PolicyEngine', () => {
  it('allows action on allowed network', () => {
    const engine = new PolicyEngine({ allowedNetworks: ['goat-testnet'], maxRiskWithoutConfirm: 'high', writeEnabled: true });
    const result = engine.evaluate({ action: makeAction(), context: ctx, payload: {} });
    expect(result.allowed).toBe(true);
  });

  it('blocks action on disallowed network', () => {
    const engine = new PolicyEngine({ allowedNetworks: ['goat-mainnet'], maxRiskWithoutConfirm: 'high', writeEnabled: true });
    const result = engine.evaluate({ action: makeAction(), context: ctx, payload: {} });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Network not allowed');
  });

  it('blocks write actions when writeEnabled is false', () => {
    const engine = new PolicyEngine({ allowedNetworks: ['goat-testnet'], maxRiskWithoutConfirm: 'high', writeEnabled: false });
    const result = engine.evaluate({ action: makeAction({ riskLevel: 'low' }), context: ctx, payload: {} });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Write actions are disabled');
  });

  it('allows read actions even when writeEnabled is false', () => {
    const engine = new PolicyEngine({ allowedNetworks: ['goat-testnet'], maxRiskWithoutConfirm: 'high', writeEnabled: false });
    const result = engine.evaluate({ action: makeAction({ riskLevel: 'read' }), context: ctx, payload: {} });
    expect(result.allowed).toBe(true);
  });

  it('blocks high-risk unconfirmed when maxRisk is low', () => {
    const engine = new PolicyEngine({ allowedNetworks: ['goat-testnet'], maxRiskWithoutConfirm: 'low', writeEnabled: true });
    const result = engine.evaluate({ action: makeAction({ riskLevel: 'high' }), context: ctx, payload: {} });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Confirmation required');
  });

  it('allows high-risk when confirmed', () => {
    const engine = new PolicyEngine({ allowedNetworks: ['goat-testnet'], maxRiskWithoutConfirm: 'low', writeEnabled: true });
    const result = engine.evaluate({ action: makeAction({ riskLevel: 'high' }), context: ctx, payload: {}, confirmed: true });
    expect(result.allowed).toBe(true);
  });

  it('blocks requiresConfirmation action when not confirmed', () => {
    const engine = new PolicyEngine({ allowedNetworks: ['goat-testnet'], maxRiskWithoutConfirm: 'high', writeEnabled: true });
    const result = engine.evaluate({ action: makeAction({ requiresConfirmation: true }), context: ctx, payload: {} });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('requires confirmation');
  });

  it('allows requiresConfirmation action when confirmed', () => {
    const engine = new PolicyEngine({ allowedNetworks: ['goat-testnet'], maxRiskWithoutConfirm: 'high', writeEnabled: true });
    const result = engine.evaluate({ action: makeAction({ requiresConfirmation: true }), context: ctx, payload: {}, confirmed: true });
    expect(result.allowed).toBe(true);
  });
});
