/**
 * The agentkit-gns CLI implementation. The thin `bin/gns.mjs` shim
 * loads this module via `tsx/esm/api` so we can write CLI logic in
 * TypeScript while keeping the published binary as a `.mjs` shebang.
 *
 * Subcommand wiring is intentionally explicit (no per-subcommand
 * dynamic dispatch) so commander can derive `--help` from the literal
 * `.command(...)` chain.
 */
import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import {
  ExitCodes,
  type ExitCode,
  classifyExitCode,
  loadEnvFromCwd,
  runAction,
  reportResult,
  handleCaughtError,
} from './command-runner';
import { emit, status } from './output';
import { confirm } from './confirmations';
import { createWalletPair } from './wallet-from-env';
import { runDoctor } from './doctor';
import { GNS_CLI_METADATA } from './commands/gns/metadata';
import { goatNetworks } from '../../networks/goat/config';
import { ActionProvider } from '../../providers/action-provider';
import { PolicyEngine } from '../../core/policy/policy-engine';
import { ExecutionRuntime } from '../../core/runtime/execution-runtime';
import type { ActionContext } from '../../core/schema/action';
import { HttpGnsApiAdapter, getGnsContracts } from '../../plugins/gns/index';
import { checkAvailabilityAction } from '../../plugins/gns/actions/check-availability';
import { commitAction } from '../../plugins/gns/actions/commit';
import { estimatePriceAction } from '../../plugins/gns/actions/estimate-price';
import { getMyNamesAction } from '../../plugins/gns/actions/get-my-names';
import { getNameDetailsAction } from '../../plugins/gns/actions/get-name-details';
import { registerAction } from '../../plugins/gns/actions/register';
import { renewAction } from '../../plugins/gns/actions/renew';
import { setPrimaryNameAction } from '../../plugins/gns/actions/set-primary-name';
import { setProfileRecordsAction } from '../../plugins/gns/actions/set-profile-records';
import { waitForCommitmentAction } from '../../plugins/gns/actions/wait-for-commitment';
import { x402CreateOrderAction } from '../../plugins/gns/actions/x402-create-order';
import { x402GetOrderStatusAction } from '../../plugins/gns/actions/x402-get-order-status';
import { x402PayOrderAction } from '../../plugins/gns/actions/x402-pay-order';
import { x402SubmitSignatureAction } from '../../plugins/gns/actions/x402-submit-signature';
import { EvmPayerWalletAdapter } from '../../plugins/x402/adapters/evm-payer-wallet';
import { JsonRpcProvider, Wallet } from 'ethers';

interface GlobalOpts {
  network?: 'goat-mainnet' | 'goat-testnet';
  apiBaseUrl?: string;
  dryRun?: boolean;
  json?: boolean;
  quiet?: boolean;
  autoConfirm?: boolean;
  revealSecrets?: boolean;
}

function getGlobals(cmd: Command): GlobalOpts {
  let cursor: Command | null = cmd;
  while (cursor && cursor.parent) cursor = cursor.parent;
  return (cursor?.opts() as GlobalOpts) ?? {};
}

function format(globals: GlobalOpts): 'json' | 'human' {
  return globals.json ? 'json' : 'human';
}

function getNetwork(globals: GlobalOpts): 'goat-mainnet' | 'goat-testnet' {
  return globals.network ?? 'goat-testnet';
}

function getApi(globals: GlobalOpts) {
  const network = getNetwork(globals);
  return new HttpGnsApiAdapter({
    baseUrl: globals.apiBaseUrl ?? process.env.GNS_API_BASE_URL,
    network,
  });
}

export async function runGnsCli(argv: readonly string[]): Promise<ExitCode> {
  loadEnvFromCwd();

  const program = new Command();
  program
    .name(GNS_CLI_METADATA.bin)
    .description(GNS_CLI_METADATA.summary)
    .option('--network <network>', 'goat-mainnet or goat-testnet (default: goat-testnet)', (val) => {
      if (val !== 'goat-mainnet' && val !== 'goat-testnet') {
        throw new Error(`invalid --network value: ${val}`);
      }
      return val;
    })
    .option('--api-base-url <url>', 'Override GNS_API_BASE_URL')
    .option('--dry-run', 'Validate inputs but skip on-chain writes (register / x402-register)')
    .option('--json', 'Emit machine-readable JSON to stdout')
    .option('--quiet', 'No spinners / prompts; fail if a prompt would appear')
    .option('--auto-confirm', 'Skip interactive y/N gates')
    .option('--reveal-secrets', 'Display secret outputs in the clear (subject to action sensitiveOutputFields)')
    .exitOverride();

  // -- lookup ----------------------------------------------------------------
  program
    .command('lookup <name>')
    .description('Read full details for a .goat name')
    .action(async (name: string) => {
      const globals = getGlobals(program);
      const action = getNameDetailsAction(getApi(globals));
      const { result, exitCode } = await runAction(action, {
        network: getNetwork(globals),
        input: { name },
        format: format(globals),
      });
      reportResult(result, format(globals));
      process.exitCode = exitCode;
    });

  // -- search ----------------------------------------------------------------
  program
    .command('search <query>')
    .description('Check availability for a query string')
    .action(async (query: string) => {
      const globals = getGlobals(program);
      const action = checkAvailabilityAction(getApi(globals));
      const { result, exitCode } = await runAction(action, {
        network: getNetwork(globals),
        input: { name: query },
        format: format(globals),
      });
      reportResult(result, format(globals));
      process.exitCode = exitCode;
    });

  // -- my-names --------------------------------------------------------------
  program
    .command('my-names <address>')
    .description('List .goat names owned by a wallet')
    .action(async (address: string) => {
      const globals = getGlobals(program);
      const action = getMyNamesAction(getApi(globals));
      const { result, exitCode } = await runAction(action, {
        network: getNetwork(globals),
        input: { address },
        format: format(globals),
      });
      reportResult(result, format(globals));
      process.exitCode = exitCode;
    });

  // -- price -----------------------------------------------------------------
  program
    .command('price <name>')
    .description('Quote registration price')
    .option('--years <n>', 'Term in years', '1')
    .option('--token <symbol>', 'Payment token symbol (informational)', 'USDC')
    .option('--token-contract <address>', 'Override payment token contract')
    .action(async (
      name: string,
      cmdOpts: { years: string; token: string; tokenContract?: string },
    ) => {
      const globals = getGlobals(program);
      const action = estimatePriceAction(getApi(globals));
      const { result, exitCode } = await runAction(action, {
        network: getNetwork(globals),
        input: {
          name,
          years: Number(cmdOpts.years),
          tokenContract: cmdOpts.tokenContract,
        },
        format: format(globals),
      });
      reportResult(result, format(globals));
      process.exitCode = exitCode;
    });

  // -- register --------------------------------------------------------------
  program
    .command('register <name>')
    .description('Full register flow: commit → wait → register → records → primary')
    .option('--years <n>', 'Term in years', '1')
    .option('--token <symbol>', 'Payment token symbol', 'USDC')
    .option('--token-contract <address>', 'Override payment token contract')
    .option('--owner <address>', 'Owner address (defaults to wallet address)')
    .option('--reverse', 'Also set the reverse (primary) record')
    .option('--description <text>', 'Set description text record')
    .option('--url <text>', 'Set url text record')
    .option('--email <text>', 'Set email text record')
    .option('--amount-wei <wei>', 'Override max payment amount')
    .option(
      '--wait-timeout <sec>',
      'Max seconds to poll for the commit reveal window (minCommitmentAge is 60s)',
      '180',
    )
    .option('--poll-interval <sec>', 'Seconds between commit-readiness polls', '10')
    .action(async (
      name: string,
      cmdOpts: {
        years: string;
        token: string;
        tokenContract?: string;
        owner?: string;
        reverse?: boolean;
        description?: string;
        url?: string;
        email?: string;
        amountWei?: string;
        waitTimeout: string;
        pollInterval: string;
      },
    ) => {
      const globals = getGlobals(program);
      const fmt = format(globals);
      const networkKey = getNetwork(globals);
      const contracts = getGnsContracts(networkKey);
      const api = getApi(globals);
      const { authWallet: wallet } = createWalletPair({ network: networkKey, allowMock: globals.dryRun === true });
      const years = Number(cmdOpts.years);
      const owner = (cmdOpts.owner ?? (await wallet.getAddress())) as `0x${string}`;

      if (globals.dryRun) {
        emit(
          {
            dryRun: true,
            plan: ['estimatePrice', 'commit', 'waitForCommitment', 'register', ...(cmdOpts.description || cmdOpts.url || cmdOpts.email ? ['setProfileRecords'] : []), ...(cmdOpts.reverse ? ['setPrimaryName'] : [])],
            name,
            owner,
            years,
            token: cmdOpts.token,
          },
          fmt,
        );
        process.exitCode = ExitCodes.SUCCESS;
        return;
      }

      if (!globals.autoConfirm) {
        const okay = await confirm(`Register ${name} for ${years} year(s)?`, {
          autoConfirm: globals.autoConfirm,
          quiet: globals.quiet,
        });
        if (!okay) {
          status('warn', 'aborted by user');
          process.exitCode = ExitCodes.USER_INPUT;
          return;
        }
      }

      // Quote price.
      const quote = await runAction(estimatePriceAction(api), {
        network: networkKey,
        input: { name, years, tokenContract: cmdOpts.tokenContract },
        format: fmt,
      });
      if (!quote.result.ok || !quote.result.output) {
        reportResult(quote.result, fmt);
        process.exitCode = quote.exitCode;
        return;
      }
      const quoteOut = quote.result.output as { currency: string; totalWei: string };
      const paymentTokenAddress = (cmdOpts.tokenContract ?? quoteOut.currency) as `0x${string}`;
      const paymentTokenSymbol = cmdOpts.token;
      const amountWei = cmdOpts.amountWei ?? quoteOut.totalWei;

      // Commit.
      const commit = await runAction(commitAction(contracts, wallet), {
        network: networkKey,
        input: {
          name,
          owner,
          years,
          paymentTokenAddress,
          paymentTokenSymbol,
          amountWei,
        },
        executionOptions: globals.revealSecrets
          ? { confirmed: true, revealedFields: ['secret'] }
          : { confirmed: true },
        format: fmt,
      });
      if (!commit.result.ok || !commit.result.output) {
        reportResult(commit.result, fmt);
        process.exitCode = commit.exitCode;
        return;
      }
      type CommitOutput = {
        commitment: `0x${string}`;
        secret: `0x${string}`;
        registration: { duration: string; data: string[]; reverseRecord: 0 | 1; referrer: string };
        paymentToken: { address: `0x${string}` };
        payment: { paymentToken: `0x${string}` };
      };
      const commitOut = commit.result.output as unknown as CommitOutput;
      reportResult(commit.result, fmt);

      // Wait — poll the on-chain reveal window. minCommitmentAge is 60s, so a
      // single immediate check always fails; poll until isReady or timeout.
      const waitTimeoutMs = Math.max(0, Number(cmdOpts.waitTimeout) * 1000);
      const pollIntervalMs = Math.max(1000, Number(cmdOpts.pollInterval) * 1000);
      const deadline = Date.now() + waitTimeoutMs;
      let ready = false;
      let lastWait: Awaited<ReturnType<typeof runAction>> | undefined;
      for (;;) {
        lastWait = await runAction(waitForCommitmentAction(contracts, wallet), {
          network: networkKey,
          input: { commitment: commitOut.commitment },
          format: fmt,
        });
        if (lastWait.exitCode !== ExitCodes.SUCCESS) {
          reportResult(lastWait.result, fmt);
          process.exitCode = lastWait.exitCode;
          return;
        }
        const out = lastWait.result.output as { isReady?: boolean; isExpired?: boolean } | undefined;
        if (out?.isExpired) {
          status('error', 'commitment expired before reveal window opened; re-run register to start over');
          process.exitCode = ExitCodes.CHAIN_OR_STATE;
          return;
        }
        if (out?.isReady) {
          ready = true;
          break;
        }
        if (Date.now() >= deadline) break;
        const remaining = Math.ceil((deadline - Date.now()) / 1000);
        status('info', `commit not yet revealable; polling again in ${pollIntervalMs / 1000}s (timeout in ${remaining}s)`);
        await new Promise((r) => setTimeout(r, Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()))));
      }
      reportResult(lastWait!.result, fmt);
      if (!ready) {
        status('error', `commit reveal window did not open within ${cmdOpts.waitTimeout}s; re-run register (the commit persists on-chain up to maxCommitmentAge)`);
        process.exitCode = ExitCodes.CHAIN_OR_STATE;
        return;
      }

      // Register.
      const reg = await runAction(registerAction(contracts, wallet), {
        network: networkKey,
        input: {
          name,
          commitHash: commitOut.commitment,
          paymentTokenAddress: commitOut.payment.paymentToken,
          paymentTokenSymbol,
          amountWei,
          duration: commitOut.registration.duration,
          years,
          secret: commitOut.secret,
          owner,
          resolverData: commitOut.registration.data,
          reverseRecord: commitOut.registration.reverseRecord,
          referrer: commitOut.registration.referrer,
        },
        executionOptions: { confirmed: true },
        format: fmt,
      });
      reportResult(reg.result, fmt);
      if (reg.exitCode !== ExitCodes.SUCCESS) {
        process.exitCode = reg.exitCode;
        return;
      }

      // Optional records.
      const records: Array<{ key: string; value: string }> = [];
      if (cmdOpts.description) records.push({ key: 'description', value: cmdOpts.description });
      if (cmdOpts.url) records.push({ key: 'url', value: cmdOpts.url });
      if (cmdOpts.email) records.push({ key: 'email', value: cmdOpts.email });
      if (records.length) {
        const setRes = await runAction(setProfileRecordsAction(contracts, wallet), {
          network: networkKey,
          input: { name, records },
          executionOptions: { confirmed: true },
          format: fmt,
        });
        reportResult(setRes.result, fmt);
        if (setRes.exitCode !== ExitCodes.SUCCESS) {
          process.exitCode = setRes.exitCode;
          return;
        }
      }

      if (cmdOpts.reverse) {
        const primary = await runAction(setPrimaryNameAction(contracts, wallet), {
          network: networkKey,
          input: { name },
          executionOptions: { confirmed: true },
          format: fmt,
        });
        reportResult(primary.result, fmt);
        if (primary.exitCode !== ExitCodes.SUCCESS) {
          process.exitCode = primary.exitCode;
          return;
        }
      }

      process.exitCode = ExitCodes.SUCCESS;
    });

  // -- renew -----------------------------------------------------------------
  program
    .command('renew <name>')
    .description('Renew a .goat name')
    .option('--years <n>', 'Years to extend', '1')
    .option('--token <symbol>', 'Payment token symbol', 'USDC')
    .option('--token-contract <address>', 'Override payment token contract')
    .option('--amount-wei <wei>', 'Override max payment amount')
    .action(async (
      name: string,
      cmdOpts: { years: string; token: string; tokenContract?: string; amountWei?: string },
    ) => {
      const globals = getGlobals(program);
      const fmt = format(globals);
      const networkKey = getNetwork(globals);
      const contracts = getGnsContracts(networkKey);
      const api = getApi(globals);
      const { authWallet: wallet } = createWalletPair({ network: networkKey, allowMock: globals.dryRun === true });

      const years = Number(cmdOpts.years);
      let amountWei = cmdOpts.amountWei;
      let tokenAddress = cmdOpts.tokenContract;
      if (!amountWei || !tokenAddress) {
        const quote = await runAction(estimatePriceAction(api), {
          network: networkKey,
          input: { name, years, tokenContract: tokenAddress },
          format: fmt,
        });
        if (!quote.result.ok || !quote.result.output) {
          reportResult(quote.result, fmt);
          process.exitCode = quote.exitCode;
          return;
        }
        const q = quote.result.output as { currency: string; totalWei: string };
        amountWei = amountWei ?? q.totalWei;
        tokenAddress = (tokenAddress ?? q.currency) as `0x${string}`;
      }

      const renew = await runAction(renewAction(contracts, wallet), {
        network: networkKey,
        input: {
          name,
          years,
          paymentTokenAddress: tokenAddress as `0x${string}`,
          amountWei,
        },
        executionOptions: { confirmed: true },
        format: fmt,
      });
      reportResult(renew.result, fmt);
      process.exitCode = renew.exitCode;
    });

  // -- set-records -----------------------------------------------------------
  program
    .command('set-records <name>')
    .description('Set resolver text records')
    .option('--description <text>', 'Set description text record')
    .option('--url <text>', 'Set url text record')
    .option('--email <text>', 'Set email text record')
    .option('--text <pair...>', 'Arbitrary key=value records', collectKv, [] as Array<{ key: string; value: string }>)
    .action(async (
      name: string,
      cmdOpts: { description?: string; url?: string; email?: string; text?: Array<{ key: string; value: string }> },
    ) => {
      const globals = getGlobals(program);
      const fmt = format(globals);
      const networkKey = getNetwork(globals);
      const contracts = getGnsContracts(networkKey);
      const { authWallet: wallet } = createWalletPair({ network: networkKey, allowMock: globals.dryRun === true });

      const records: Array<{ key: string; value: string }> = [];
      if (cmdOpts.description) records.push({ key: 'description', value: cmdOpts.description });
      if (cmdOpts.url) records.push({ key: 'url', value: cmdOpts.url });
      if (cmdOpts.email) records.push({ key: 'email', value: cmdOpts.email });
      if (cmdOpts.text) records.push(...cmdOpts.text);
      if (!records.length) {
        status('error', 'no records supplied; pass at least one of --description / --url / --email / --text key=value');
        process.exitCode = ExitCodes.USER_INPUT;
        return;
      }

      const res = await runAction(setProfileRecordsAction(contracts, wallet), {
        network: networkKey,
        input: { name, records },
        executionOptions: { confirmed: true },
        format: fmt,
      });
      reportResult(res.result, fmt);
      process.exitCode = res.exitCode;
    });

  // -- set-primary -----------------------------------------------------------
  program
    .command('set-primary <name>')
    .description("Set the caller's primary .goat name")
    .option('--address <address>', 'Address to set primary for (defaults to wallet)')
    .action(async (name: string, _cmdOpts: { address?: string }) => {
      const globals = getGlobals(program);
      const fmt = format(globals);
      const networkKey = getNetwork(globals);
      const contracts = getGnsContracts(networkKey);
      const { authWallet: wallet } = createWalletPair({ network: networkKey, allowMock: globals.dryRun === true });

      const res = await runAction(setPrimaryNameAction(contracts, wallet), {
        network: networkKey,
        input: { name },
        executionOptions: { confirmed: true },
        format: fmt,
      });
      reportResult(res.result, fmt);
      process.exitCode = res.exitCode;
    });

  // -- x402-register ---------------------------------------------------------
  program
    .command('x402-register <name>')
    .description('Cross-chain register paid from another EVM chain')
    .option('--years <n>', 'Term in years', '1')
    .option('--pay-chain <chainId>', 'Source chain id', '8453')
    .option('--pay-token <symbol>', 'Source token symbol', 'USDC')
    .option('--pay-token-contract <address>', 'Source token contract address')
    .action(async (
      name: string,
      cmdOpts: { years: string; payChain: string; payToken: string; payTokenContract?: string },
    ) => {
      const globals = getGlobals(program);
      const fmt = format(globals);
      const networkKey = getNetwork(globals);
      const contracts = getGnsContracts(networkKey);
      const api = getApi(globals);

      if (globals.dryRun) {
        emit(
          {
            dryRun: true,
            plan: ['commit', 'x402.createOrder', 'x402.submitSignature', 'x402.payOrder', 'x402.getOrderStatus'],
            name,
            years: Number(cmdOpts.years),
            payChain: Number(cmdOpts.payChain),
            payToken: cmdOpts.payToken,
          },
          fmt,
        );
        process.exitCode = ExitCodes.SUCCESS;
        return;
      }

      const goatRpc = goatNetworks[networkKey].rpcUrl;
      const goatPrivateKey = process.env.GOAT_PRIVATE_KEY;
      const sourceRpc = process.env.PAYMENT_CHAIN_RPC_URL;
      const sourcePrivateKey = process.env.PAYMENT_CHAIN_PRIVATE_KEY ?? goatPrivateKey;
      if (!goatPrivateKey || !sourceRpc || !sourcePrivateKey || !cmdOpts.payTokenContract) {
        status('error', 'x402-register requires GOAT_PRIVATE_KEY, PAYMENT_CHAIN_RPC_URL, PAYMENT_CHAIN_PRIVATE_KEY, and --pay-token-contract');
        process.exitCode = ExitCodes.USER_INPUT;
        return;
      }

      const goatPair = createWalletPair({ network: networkKey, allowMock: false });
      const goatWallet = goatPair.authWallet;
      const sourceWallet = goatPair.paymentWallet;

      const goatPayer = new EvmPayerWalletAdapter(new Wallet(goatPrivateKey, new JsonRpcProvider(goatRpc)));
      const sourcePayer = new EvmPayerWalletAdapter(
        new Wallet(sourcePrivateKey, new JsonRpcProvider(sourceRpc)),
      );

      // Use a single ActionProvider so we can route across networks.
      const provider = new ActionProvider();
      provider.register(commitAction(contracts, goatWallet));
      provider.register(x402CreateOrderAction(api));
      provider.register(x402SubmitSignatureAction(api, goatPayer));
      provider.register(x402PayOrderAction(api, sourcePayer, sourceWallet));
      provider.register(x402GetOrderStatusAction(api));

      const policy = new PolicyEngine({
        allowedNetworks: [networkKey, 'payment-chain', `evm-${cmdOpts.payChain}`],
        maxRiskWithoutConfirm: 'low',
        writeEnabled: true,
      });
      const stderrLogger = {
        log(level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>): void {
          process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level, message, ...meta }) + '\n');
        },
      };
      const runtime = new ExecutionRuntime(policy, { maxRetries: 0, retryDelayMs: 200, logger: stderrLogger });
      const owner = (await goatWallet.getAddress()) as `0x${string}`;
      const baseCtx: ActionContext = { traceId: `cli_${randomUUID()}`, network: networkKey, now: Date.now() };

      const commit = await runtime.run(
        provider.get('goat.gns.commit'),
        baseCtx,
        {
          name,
          owner,
          years: Number(cmdOpts.years),
          paymentTokenAddress: contracts.publicResolver,
          paymentTokenSymbol: cmdOpts.payToken,
          amountWei: '0',
        },
        globals.revealSecrets ? { confirmed: true, revealedFields: ['secret'] } : { confirmed: true },
      );
      reportResult(commit, fmt);
      type CommitOutput = { commitment: `0x${string}`; secret: `0x${string}` };
      if (!commit.ok || !commit.output) {
        process.exitCode = classifyExitCode(commit.errorCode, commit.error);
        return;
      }
      const commitOut = commit.output as unknown as CommitOutput;

      const order = await runtime.run(
        provider.get('goat.gns.x402.createOrder'),
        baseCtx,
        {
          name,
          owner,
          payer: owner,
          years: Number(cmdOpts.years),
          settlementChainId: Number(cmdOpts.payChain),
          settlementTokenSymbol: cmdOpts.payToken,
          settlementTokenContract: cmdOpts.payTokenContract,
          secret: commitOut.secret,
          commitment: commitOut.commitment,
        },
        { confirmed: true },
      );
      reportResult(order, fmt);
      if (!order.ok || !order.output) {
        process.exitCode = ExitCodes.ADAPTER;
        return;
      }
      const orderOut = order.output as { orderId: string; calldataSignRequest: unknown };

      const signed = await runtime.run(
        provider.get('goat.gns.x402.submitSignature'),
        baseCtx,
        {
          orderId: orderOut.orderId,
          calldataSignRequest: orderOut.calldataSignRequest,
        },
        { confirmed: true },
      );
      reportResult(signed, fmt);
      if (!signed.ok) {
        process.exitCode = classifyExitCode(signed.errorCode, signed.error);
        return;
      }

      const sourceCtx: ActionContext = { ...baseCtx, network: `evm-${cmdOpts.payChain}` };
      const paid = await runtime.run(
        provider.get('goat.gns.x402.payOrder'),
        sourceCtx,
        { orderId: orderOut.orderId },
        { confirmed: true },
      );
      reportResult(paid, fmt);
      if (!paid.ok) {
        process.exitCode = ExitCodes.CHAIN_OR_STATE;
        return;
      }

      const statusRes = await runtime.run(
        provider.get('goat.gns.x402.getOrderStatus'),
        baseCtx,
        { orderId: orderOut.orderId },
      );
      reportResult(statusRes, fmt);
      process.exitCode = statusRes.ok ? ExitCodes.SUCCESS : classifyExitCode(statusRes.errorCode, statusRes.error);
    });

  // -- doctor ----------------------------------------------------------------
  program
    .command('doctor')
    .description('Diagnose env vars, API connectivity, and wallet config')
    .action(async () => {
      const globals = getGlobals(program);
      const fmt = format(globals);
      const networkKey = getNetwork(globals);
      const apiUrl =
        globals.apiBaseUrl ?? process.env.GNS_API_BASE_URL ??
        (networkKey === 'goat-mainnet'
          ? 'https://gns-api.goat.network/api'
          : 'https://gns-api.testnet3.goat.network/api');
      const report = await runDoctor({
        envVars: [
          { name: 'GNS_API_BASE_URL', required: false },
          { name: 'GNS_NETWORK', required: false },
          { name: 'GOAT_PRIVATE_KEY', required: false },
          { name: 'GOAT_TESTNET_RPC_URL', required: false },
          { name: 'GOAT_MAINNET_RPC_URL', required: false },
        ],
        apiUrl,
        network: networkKey,
      });
      emit(report, fmt);
      process.exitCode = report.ok ? ExitCodes.SUCCESS : ExitCodes.USER_INPUT;
    });

  try {
    await program.parseAsync(argv as string[], { from: 'node' });
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err) {
      const code = (err as { code?: string }).code ?? '';
      // commander returns its own error codes via exitOverride; map known ones.
      if (code === 'commander.helpDisplayed' || code === 'commander.help' || code === 'commander.version') {
        return ExitCodes.SUCCESS;
      }
      if (code.startsWith('commander.')) {
        return ExitCodes.USER_INPUT;
      }
    }
    return handleCaughtError(err, format(getGlobals(program)));
  }
  return (process.exitCode as ExitCode) ?? ExitCodes.SUCCESS;
}

function collectKv(
  value: string,
  previous: Array<{ key: string; value: string }>,
): Array<{ key: string; value: string }> {
  const idx = value.indexOf('=');
  if (idx <= 0) throw new Error(`--text expects key=value (got: ${value})`);
  return [...previous, { key: value.slice(0, idx), value: value.slice(idx + 1) }];
}
