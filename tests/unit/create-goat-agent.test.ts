import { describe, it, expect } from 'vitest';
import { generateProject } from '../../bin/create-goat-agent';
import type { Preset } from '../../bin/create-goat-agent';
import * as pluginsExports from '../../plugins/index';
import * as coreExports from '../../core/index';
import * as providersExports from '../../providers/index';

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
    expect(pkg.devDependencies).toHaveProperty('@types/node');
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
    expect(src).toContain('dexSwapAction');
    expect(src).toContain('oftSendAction');
    expect(src).toContain('erc8004RegisterAgentAction');
    expect(src).toContain('bitvm2RegisterPubkeyAction');
    expect(src).toContain('bitvm2StakeAction');
    // x402/faucet require adapters — rendered as TODO comments
    expect(src).toContain('x402 actions require');
    expect(src).toContain('faucet actions require');
  });

  it('embeds selected network in generated code', () => {
    const files = generateProject({ projectName: 'a', preset: 'minimal', network: 'goat-mainnet' });
    expect(files['src/index.ts']).toContain("'goat-mainnet'");
    expect(files['.env.example']).toContain('goat-mainnet');
  });

  it('generated code includes wallet instantiation', () => {
    const files = generateProject({ projectName: 'a', preset: 'minimal', network: 'goat-testnet' });
    const src = files['src/index.ts'];
    expect(src).toContain('NoopWalletProvider');
    expect(src).toContain('const wallet');
  });

  it('generated code passes wallet to action factories', () => {
    const files = generateProject({ projectName: 'a', preset: 'defi', network: 'goat-testnet' });
    const src = files['src/index.ts'];
    expect(src).toContain('walletBalanceAction(new NoopWalletReadAdapter())');
    expect(src).toContain('wgbtcWrapAction(wallet)');
    expect(src).toContain('onchainBridgeWithdraw(wallet)');
  });

  it('uses bridgeReplaceByFeeAction (not bridgeRbfAction)', () => {
    const files = generateProject({ projectName: 'a', preset: 'defi', network: 'goat-testnet' });
    const src = files['src/index.ts'];
    expect(src).toContain('bridgeReplaceByFeeAction');
    expect(src).not.toContain('bridgeRbfAction');
  });

  it.each<Preset>(['minimal', 'defi', 'full'])('all imports in %s preset resolve against actual exports', (preset) => {
    const files = generateProject({ projectName: 'a', preset, network: 'goat-mainnet' });
    const src = files['src/index.ts'];

    // Extract all named imports from 'agentkit/plugins', 'agentkit/core', 'agentkit/providers'
    const importRegex = /import\s*\{([^}]+)\}\s*from\s*'agentkit\/(plugins|core|providers)'/g;
    const exportMaps: Record<string, Record<string, unknown>> = {
      plugins: pluginsExports,
      core: coreExports,
      providers: providersExports,
    };

    let match;
    while ((match = importRegex.exec(src)) !== null) {
      const names = match[1].split(',').map((s) => s.trim()).filter(Boolean);
      const module = match[2];
      const exports = exportMaps[module];
      for (const name of names) {
        // Handle "Foo as Bar" aliases — check the original name
        const originalName = name.includes(' as ') ? name.split(' as ')[0].trim() : name;
        expect(exports, `'${originalName}' not exported from agentkit/${module}`).toHaveProperty(originalName);
      }
    }
  });

  it('full preset uses MERCHANT_PORTAL_BASE_URL (not MERCHANT_API_BASE_URL)', () => {
    const files = generateProject({ projectName: 'a', preset: 'full', network: 'goat-mainnet' });
    const src = files['src/index.ts'];
    const env = files['.env.example'];

    expect(src).toContain('MERCHANT_PORTAL_BASE_URL');
    expect(src).not.toContain('MERCHANT_API_BASE_URL');
    expect(env).toContain('MERCHANT_PORTAL_BASE_URL');
  });

  it('minimal preset .env.example omits merchant portal config', () => {
    const files = generateProject({ projectName: 'a', preset: 'minimal', network: 'goat-testnet' });
    expect(files['.env.example']).not.toContain('MERCHANT_PORTAL_BASE_URL');
  });

  it('tsconfig uses Bundler module resolution', () => {
    const files = generateProject({ projectName: 'a', preset: 'minimal', network: 'goat-testnet' });
    const tsconfig = JSON.parse(files['tsconfig.json']);
    expect(tsconfig.compilerOptions.moduleResolution).toBe('Bundler');
  });
});
