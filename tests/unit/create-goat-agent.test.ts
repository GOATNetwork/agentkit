import { describe, it, expect } from 'vitest';
import { generateProject } from '../../bin/create-goat-agent';
import type { Preset } from '../../bin/create-goat-agent';

describe('generateProject', () => {
  const PRESETS: Preset[] = ['minimal', 'defi', 'full'];

  it.each(PRESETS)('generates correct file set for %s preset', (preset) => {
    const files = generateProject({ projectName: 'test-agent', preset, network: 'goat-testnet' });

    expect(Object.keys(files).sort()).toEqual([
      '.env.example',
      'README.md',
      'package.json',
      'src/index.ts',
      'tsconfig.json',
    ]);
  });

  it('package.json contains required dependencies', () => {
    const files = generateProject({ projectName: 'my-agent', preset: 'minimal', network: 'goat-testnet' });
    const pkg = JSON.parse(files['package.json']);

    expect(pkg.name).toBe('my-agent');
    expect(pkg.dependencies).toHaveProperty('agentkit');
    expect(pkg.dependencies).toHaveProperty('zod');
    expect(pkg.devDependencies).toHaveProperty('tsx');
    expect(pkg.devDependencies).toHaveProperty('typescript');
  });

  it('minimal preset imports only wallet plugin', () => {
    const files = generateProject({ projectName: 'a', preset: 'minimal', network: 'goat-testnet' });
    const src = files['src/index.ts'];

    expect(src).toContain('walletBalanceAction');
    expect(src).not.toContain('wgbtcWrapAction');
    expect(src).not.toContain('bitcoinBlockHashAction');
  });

  it('defi preset imports wallet + wgbtc + bridge + bitcoin', () => {
    const files = generateProject({ projectName: 'a', preset: 'defi', network: 'goat-testnet' });
    const src = files['src/index.ts'];

    expect(src).toContain('walletBalanceAction');
    expect(src).toContain('wgbtcWrapAction');
    expect(src).toContain('onchainBridgeWithdraw');
    expect(src).toContain('bitcoinBlockHashAction');
  });

  it('full preset includes all plugin references', () => {
    const files = generateProject({ projectName: 'a', preset: 'full', network: 'goat-mainnet' });
    const src = files['src/index.ts'];

    expect(src).toContain('walletBalanceAction');
    expect(src).toContain('wgbtcWrapAction');
    expect(src).toContain('bitcoinBlockHashAction');
    expect(src).toContain('erc721BalanceAction');
    expect(src).toContain('goatTokenDelegateAction');
    // x402/bitvm2/faucet require adapters — rendered as TODO comments
    expect(src).toContain('x402 actions require');
    expect(src).toContain('bitvm2 actions require');
    expect(src).toContain('faucet actions require');
  });

  it('embeds selected network in generated code', () => {
    const files = generateProject({ projectName: 'a', preset: 'minimal', network: 'goat-mainnet' });
    expect(files['src/index.ts']).toContain("'goat-mainnet'");
    expect(files['.env.example']).toContain('goat-mainnet');
  });
});
