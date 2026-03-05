#!/usr/bin/env tsx

import * as readline from 'node:readline/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

/* ------------------------------------------------------------------ */
/*  Preset definitions                                                 */
/* ------------------------------------------------------------------ */

export type Preset = 'minimal' | 'defi' | 'full';

const PRESET_PLUGINS: Record<Preset, string[]> = {
  minimal: ['wallet'],
  defi: ['wallet', 'wgbtc', 'bridge', 'bitcoin'],
  full: ['wallet', 'wgbtc', 'bridge', 'bitcoin', 'x402', 'bitvm2', 'erc721', 'faucet', 'goat-token'],
};

export interface GenerateOptions {
  projectName: string;
  preset: Preset;
  network: string;
}

/* ------------------------------------------------------------------ */
/*  Template helpers                                                   */
/* ------------------------------------------------------------------ */

function packageJson(opts: GenerateOptions): string {
  return JSON.stringify(
    {
      name: opts.projectName,
      version: '0.1.0',
      private: true,
      type: 'module',
      scripts: {
        start: 'tsx src/index.ts',
        typecheck: 'tsc --noEmit',
        test: 'vitest run',
      },
      dependencies: {
        agentkit: 'file:..', // replace with registry path once published
        zod: '^3.24.2',
      },
      devDependencies: {
        tsx: '^4.20.5',
        typescript: '^5.9.2',
        vitest: '^3.2.4',
      },
    },
    null,
    2,
  );
}

function tsconfig(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ES2022',
        moduleResolution: 'Bundler',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        outDir: 'dist',
      },
      include: ['src'],
    },
    null,
    2,
  );
}

function envExample(opts: GenerateOptions): string {
  return `# Goat Network RPC
GOAT_MAINNET_RPC_URL=https://rpc.goat.network
GOAT_TESTNET_RPC_URL=https://rpc.testnet.goat.network

# Agentkit
AGENTKIT_IDEMPOTENCY_MODE=memory
AGENTKIT_METRICS_PORT=9464

# Network: ${opts.network}
`;
}

function readme(opts: GenerateOptions): string {
  return `# ${opts.projectName}

Goat Network agent scaffolded with \`create-goat-agent\` (preset: **${opts.preset}**).

## Quick start

\`\`\`bash
pnpm install
pnpm start
\`\`\`
`;
}

function srcIndex(opts: GenerateOptions): string {
  const plugins = PRESET_PLUGINS[opts.preset];
  const imports = pluginImports(plugins);
  const registrations = pluginRegistrations(plugins);

  return `import { ActionProvider } from 'agentkit/providers';
import { PolicyEngine, ExecutionRuntime } from 'agentkit/core';
import { NoopWalletProvider } from 'agentkit/core';
${imports}

// Replace NoopWalletProvider with a real provider (EvmWalletProvider or ViemWalletProvider) for production use.
const wallet = new NoopWalletProvider();

const provider = new ActionProvider();
${registrations}

const policy = new PolicyEngine({
  allowedNetworks: ['${opts.network}'],
  maxRiskWithoutConfirm: 'low',
  writeEnabled: true,
});

const runtime = new ExecutionRuntime(policy, { maxRetries: 2, retryDelayMs: 200 });

console.log('Agent ready — ${opts.preset} preset, ${plugins.length} plugin(s)');
console.log('Registered actions:', provider.list().map(a => a.name));
`;
}

/* ------------------------------------------------------------------ */
/*  Per-plugin import / registration snippets                         */
/* ------------------------------------------------------------------ */

interface PluginSnippet {
  imports: string[];
  registrations: string[];
}

const PLUGIN_SNIPPETS: Record<string, PluginSnippet> = {
  wallet: {
    imports: [
      "import { walletBalanceAction, getDetailsAction, getAllowanceAction, contractReadAction, contractWriteAction, transferNativeAction, transferErc20Action, approveErc20Action, deployContractAction, resolveTokenAction } from 'agentkit/plugins';",
    ],
    registrations: [
      'provider.register(walletBalanceAction(wallet));',
      'provider.register(getDetailsAction(wallet));',
      'provider.register(getAllowanceAction(wallet));',
      'provider.register(contractReadAction(wallet));',
      'provider.register(contractWriteAction(wallet));',
      'provider.register(transferNativeAction(wallet));',
      'provider.register(transferErc20Action(wallet));',
      'provider.register(approveErc20Action(wallet));',
      'provider.register(deployContractAction(wallet));',
      'provider.register(resolveTokenAction());',
    ],
  },
  wgbtc: {
    imports: [
      "import { wgbtcWrapAction, wgbtcUnwrapAction, wgbtcBalanceAction } from 'agentkit/plugins';",
    ],
    registrations: [
      'provider.register(wgbtcWrapAction(wallet));',
      'provider.register(wgbtcUnwrapAction(wallet));',
      'provider.register(wgbtcBalanceAction(wallet));',
    ],
  },
  bridge: {
    imports: [
      "import { bridgeWithdrawAction as onchainBridgeWithdraw, bridgeCancelAction, bridgeRefundAction, bridgeReplaceByFeeAction, bridgeDepositStatusAction, bridgeWithdrawalStatusAction, bridgeGetParamsAction } from 'agentkit/plugins';",
    ],
    registrations: [
      'provider.register(onchainBridgeWithdraw(wallet));',
      'provider.register(bridgeCancelAction(wallet));',
      'provider.register(bridgeRefundAction(wallet));',
      'provider.register(bridgeReplaceByFeeAction(wallet));',
      'provider.register(bridgeDepositStatusAction(wallet));',
      'provider.register(bridgeWithdrawalStatusAction(wallet));',
      'provider.register(bridgeGetParamsAction(wallet));',
    ],
  },
  bitcoin: {
    imports: [
      "import { bitcoinBlockHashAction, bitcoinLatestHeightAction, bitcoinNetworkNameAction } from 'agentkit/plugins';",
    ],
    registrations: [
      'provider.register(bitcoinBlockHashAction(wallet));',
      'provider.register(bitcoinLatestHeightAction(wallet));',
      'provider.register(bitcoinNetworkNameAction(wallet));',
    ],
  },
  x402: {
    imports: [
      "// x402 actions require MerchantGatewayAdapter and PayerWalletAdapter — see docs",
    ],
    registrations: [
      '// TODO: register x402 actions with your adapter instances',
    ],
  },
  bitvm2: {
    imports: [
      "// bitvm2 actions require GoatAdapter — see docs",
    ],
    registrations: [
      '// TODO: register bitvm2 actions with your GoatAdapter instance',
    ],
  },
  erc721: {
    imports: [
      "import { erc721BalanceAction, erc721TransferAction, erc721MintAction } from 'agentkit/plugins';",
    ],
    registrations: [
      'provider.register(erc721BalanceAction(wallet));',
      'provider.register(erc721TransferAction(wallet));',
      'provider.register(erc721MintAction(wallet));',
    ],
  },
  faucet: {
    imports: [
      "// faucet actions require FaucetAdapter — see docs",
    ],
    registrations: [
      '// TODO: register faucet actions with your FaucetAdapter instance',
    ],
  },
  'goat-token': {
    imports: [
      "import { goatTokenDelegateAction, goatTokenGetVotesAction, goatTokenGetDelegatesAction } from 'agentkit/plugins';",
    ],
    registrations: [
      'provider.register(goatTokenDelegateAction(wallet));',
      'provider.register(goatTokenGetVotesAction(wallet));',
      'provider.register(goatTokenGetDelegatesAction(wallet));',
    ],
  },
};

function pluginImports(plugins: string[]): string {
  return plugins.flatMap((p) => PLUGIN_SNIPPETS[p]?.imports ?? []).join('\n');
}

function pluginRegistrations(plugins: string[]): string {
  return plugins.flatMap((p) => PLUGIN_SNIPPETS[p]?.registrations ?? []).join('\n');
}

/* ------------------------------------------------------------------ */
/*  Public API: generate file map (testable, no I/O)                  */
/* ------------------------------------------------------------------ */

export function generateProject(opts: GenerateOptions): Record<string, string> {
  return {
    'package.json': packageJson(opts),
    'tsconfig.json': tsconfig(),
    '.env.example': envExample(opts),
    'README.md': readme(opts),
    'src/index.ts': srcIndex(opts),
  };
}

/* ------------------------------------------------------------------ */
/*  CLI runner                                                         */
/* ------------------------------------------------------------------ */

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    const projectName = await rl.question('Project name: ');
    if (!projectName.trim()) {
      console.error('Project name is required.');
      process.exit(1);
    }

    const presetAnswer = await rl.question('Preset (minimal / defi / full) [minimal]: ');
    const preset = (['minimal', 'defi', 'full'].includes(presetAnswer.trim())
      ? presetAnswer.trim()
      : 'minimal') as Preset;

    const networkAnswer = await rl.question('Network (goat-mainnet / goat-testnet) [goat-testnet]: ');
    const network = networkAnswer.trim() || 'goat-testnet';

    const opts: GenerateOptions = { projectName: projectName.trim(), preset, network };
    const files = generateProject(opts);

    const root = path.resolve(opts.projectName);
    for (const [filePath, content] of Object.entries(files)) {
      const abs = path.join(root, filePath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf-8');
      console.log(`  created ${filePath}`);
    }

    // Install dependencies
    console.log('\nInstalling dependencies...');
    try {
      execSync('pnpm install', { cwd: root, stdio: 'inherit' });
    } catch {
      try {
        execSync('npm install', { cwd: root, stdio: 'inherit' });
      } catch {
        console.warn('Could not install dependencies automatically. Run `pnpm install` manually.');
      }
    }

    console.log(`\nDone! cd ${opts.projectName} && pnpm start`);
  } finally {
    rl.close();
  }
}

// Only run CLI when executed directly (not imported)
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.url.replace('file://', ''));
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
