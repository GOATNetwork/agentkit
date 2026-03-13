#!/usr/bin/env node

import * as readline from 'node:readline/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

/* ------------------------------------------------------------------ */
/*  Preset definitions                                                 */
/* ------------------------------------------------------------------ */

export type Preset = 'minimal' | 'defi' | 'full';

const PRESET_PLUGINS: Record<Preset, string[]> = {
  minimal: ['wallet'],
  defi: ['wallet', 'wgbtc', 'bridge', 'bitcoin'],
  full: ['wallet', 'wgbtc', 'bridge', 'bitcoin', 'x402', 'x402-merchant', 'bitvm2', 'erc721', 'faucet', 'goat-token', 'dex', 'layerzero', 'erc8004'],
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
        '@goatnetwork/agentkit': '^0.1.0',
        zod: '^3.24.2',
      },
      devDependencies: {
        '@types/node': '^22.15.0',
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
  const plugins = PRESET_PLUGINS[opts.preset];
  const lines = [
    '# Goat Network RPC',
    'GOAT_MAINNET_RPC_URL=https://rpc.goat.network',
    'GOAT_TESTNET_RPC_URL=https://rpc.testnet3.goat.network',
    '',
    '# Agentkit',
    'AGENTKIT_IDEMPOTENCY_MODE=memory',
    'AGENTKIT_METRICS_PORT=9464',
  ];
  if (plugins.includes('x402-merchant')) {
    lines.push('', '# x402 Merchant Portal', 'MERCHANT_PORTAL_BASE_URL=http://localhost:8080');
  }
  lines.push('', `# Network: ${opts.network}`, '');
  return lines.join('\n');
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

  return `import { ActionProvider } from '@goatnetwork/agentkit/providers';
import { PolicyEngine, ExecutionRuntime } from '@goatnetwork/agentkit/core';
import { NoopWalletProvider } from '@goatnetwork/agentkit/core';
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
console.log('Registered actions:', provider.list().map((a: { name: string }) => a.name));
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
      "import { walletBalanceAction, getDetailsAction, getAllowanceAction, contractReadAction, contractWriteAction, transferNativeAction, transferErc20Action, approveErc20Action, deployContractAction, resolveTokenAction, NoopWalletReadAdapter } from '@goatnetwork/agentkit/plugins';",
    ],
    registrations: [
      'provider.register(walletBalanceAction(new NoopWalletReadAdapter()));',
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
      "import { wgbtcWrapAction, wgbtcUnwrapAction, wgbtcBalanceAction } from '@goatnetwork/agentkit/plugins';",
    ],
    registrations: [
      'provider.register(wgbtcWrapAction(wallet));',
      'provider.register(wgbtcUnwrapAction(wallet));',
      'provider.register(wgbtcBalanceAction(wallet));',
    ],
  },
  bridge: {
    imports: [
      "import { bridgeWithdrawAction as onchainBridgeWithdraw, bridgeCancelAction, bridgeRefundAction, bridgeReplaceByFeeAction, bridgeDepositStatusAction, bridgeWithdrawalStatusAction, bridgeGetParamsAction } from '@goatnetwork/agentkit/plugins';",
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
      "import { bitcoinBlockHashAction, bitcoinLatestHeightAction, bitcoinNetworkNameAction } from '@goatnetwork/agentkit/plugins';",
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
      "import { bitvm2RegisterPubkeyAction, bitvm2StakeApproveAction, bitvm2StakeAction, bitvm2LockStakeAction, bitvm2PegBtcBalanceAction } from '@goatnetwork/agentkit/plugins';",
      "// bitvm2 pegin/pegout/bridge actions require GoatAdapter — see docs",
    ],
    registrations: [
      'provider.register(bitvm2RegisterPubkeyAction(wallet));',
      'provider.register(bitvm2StakeApproveAction(wallet));',
      'provider.register(bitvm2StakeAction(wallet));',
      'provider.register(bitvm2LockStakeAction(wallet));',
      'provider.register(bitvm2PegBtcBalanceAction(wallet));',
      '// TODO: register bitvm2 pegin/pegout actions with your GoatAdapter instance',
    ],
  },
  erc721: {
    imports: [
      "import { erc721BalanceAction, erc721TransferAction, erc721MintAction } from '@goatnetwork/agentkit/plugins';",
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
      "import { goatTokenDelegateAction, goatTokenGetVotesAction, goatTokenGetDelegatesAction } from '@goatnetwork/agentkit/plugins';",
    ],
    registrations: [
      'provider.register(goatTokenDelegateAction(wallet));',
      'provider.register(goatTokenGetVotesAction(wallet));',
      'provider.register(goatTokenGetDelegatesAction(wallet));',
    ],
  },
  dex: {
    imports: [
      "import { dexQuoteAction, dexSwapAction, dexGetPoolAction, dexAddLiquidityAction, dexRemoveLiquidityAction, dexCollectFeesAction, dexGetPositionAction } from '@goatnetwork/agentkit/plugins';",
    ],
    registrations: [
      'provider.register(dexQuoteAction(wallet));',
      'provider.register(dexSwapAction(wallet));',
      'provider.register(dexGetPoolAction(wallet));',
      'provider.register(dexAddLiquidityAction(wallet));',
      'provider.register(dexRemoveLiquidityAction(wallet));',
      'provider.register(dexCollectFeesAction(wallet));',
      'provider.register(dexGetPositionAction(wallet));',
    ],
  },
  layerzero: {
    imports: [
      "import { oftQuoteSendAction, oftSendAction, oftQuoteOftAction } from '@goatnetwork/agentkit/plugins';",
    ],
    registrations: [
      'provider.register(oftQuoteSendAction(wallet));',
      'provider.register(oftSendAction(wallet));',
      'provider.register(oftQuoteOftAction(wallet));',
    ],
  },
  'x402-merchant': {
    imports: [
      "import { HttpMerchantPortalClient, merchantAuthLoginAction, merchantAuthRegisterAction, merchantAuthRegisterInviteAction, merchantAuthRefreshAction, merchantDashboardStatsAction, merchantProfileGetAction, merchantProfileUpdateAction, merchantOrdersListAction, merchantOrdersGetAction, merchantBalanceGetAction, merchantBalanceTransactionsAction, merchantBalanceFeesConfigAction, merchantSupportedTokensListAction, merchantAddressesListAction, merchantAddressesAddAction, merchantAddressesRemoveAction, merchantCallbackContractsListAction, merchantCallbackContractsSubmitAction, merchantCallbackContractsRemoveAction, merchantCallbackContractsCancelSubmissionAction, merchantApiKeysGetAction, merchantApiKeysRotateAction, merchantWebhooksListAction, merchantWebhooksCreateAction, merchantWebhooksUpdateAction, merchantWebhooksDeleteAction, merchantInviteCodesListAction, merchantInviteCodesCreateAction, merchantInviteCodesRevokeAction, merchantAuditLogsListAction } from '@goatnetwork/agentkit/plugins';",
    ],
    registrations: [
      "// Auth actions return { access_token }; pass it via ActionContext.accessToken in subsequent calls.",
      "const merchantClient = new HttpMerchantPortalClient(process.env.MERCHANT_PORTAL_BASE_URL ?? 'http://localhost:8080');",
      'provider.register(merchantAuthRegisterAction(merchantClient));',
      'provider.register(merchantAuthRegisterInviteAction(merchantClient));',
      'provider.register(merchantAuthLoginAction(merchantClient));',
      'provider.register(merchantAuthRefreshAction(merchantClient));',
      'provider.register(merchantDashboardStatsAction(merchantClient));',
      'provider.register(merchantProfileGetAction(merchantClient));',
      'provider.register(merchantProfileUpdateAction(merchantClient));',
      'provider.register(merchantOrdersListAction(merchantClient));',
      'provider.register(merchantOrdersGetAction(merchantClient));',
      'provider.register(merchantBalanceGetAction(merchantClient));',
      'provider.register(merchantBalanceTransactionsAction(merchantClient));',
      'provider.register(merchantBalanceFeesConfigAction(merchantClient));',
      'provider.register(merchantSupportedTokensListAction(merchantClient));',
      'provider.register(merchantAddressesListAction(merchantClient));',
      'provider.register(merchantAddressesAddAction(merchantClient));',
      'provider.register(merchantAddressesRemoveAction(merchantClient));',
      'provider.register(merchantCallbackContractsListAction(merchantClient));',
      'provider.register(merchantCallbackContractsSubmitAction(merchantClient));',
      'provider.register(merchantCallbackContractsRemoveAction(merchantClient));',
      'provider.register(merchantCallbackContractsCancelSubmissionAction(merchantClient));',
      'provider.register(merchantApiKeysGetAction(merchantClient));',
      'provider.register(merchantApiKeysRotateAction(merchantClient));',
      'provider.register(merchantWebhooksListAction(merchantClient));',
      'provider.register(merchantWebhooksCreateAction(merchantClient));',
      'provider.register(merchantWebhooksUpdateAction(merchantClient));',
      'provider.register(merchantWebhooksDeleteAction(merchantClient));',
      'provider.register(merchantInviteCodesListAction(merchantClient));',
      'provider.register(merchantInviteCodesCreateAction(merchantClient));',
      'provider.register(merchantInviteCodesRevokeAction(merchantClient));',
      'provider.register(merchantAuditLogsListAction(merchantClient));',
    ],
  },
  erc8004: {
    imports: [
      "import { erc8004RegisterAgentAction, erc8004SetAgentURIAction, erc8004GetMetadataAction, erc8004SetMetadataAction, erc8004GetAgentWalletAction, erc8004GiveFeedbackAction, erc8004RevokeFeedbackAction, erc8004GetReputationAction, erc8004GetClientsAction } from '@goatnetwork/agentkit/plugins';",
    ],
    registrations: [
      'provider.register(erc8004RegisterAgentAction(wallet));',
      'provider.register(erc8004SetAgentURIAction(wallet));',
      'provider.register(erc8004GetMetadataAction(wallet));',
      'provider.register(erc8004SetMetadataAction(wallet));',
      'provider.register(erc8004GetAgentWalletAction(wallet));',
      'provider.register(erc8004GiveFeedbackAction(wallet));',
      'provider.register(erc8004RevokeFeedbackAction(wallet));',
      'provider.register(erc8004GetReputationAction(wallet));',
      'provider.register(erc8004GetClientsAction(wallet));',
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

    const defaultNetwork = preset === 'full' ? 'goat-mainnet' : 'goat-testnet';
    const networkAnswer = await rl.question(`Network (goat-mainnet / goat-testnet) [${defaultNetwork}]: `);
    const network = networkAnswer.trim() || defaultNetwork;

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

// Only run CLI when executed directly (not imported as a library).
// Use fs.realpathSync to resolve symlinks (npx creates symlinks to bin entries).
const isDirectRun =
  process.argv[1] &&
  fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(path.resolve(process.argv[1]));
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
