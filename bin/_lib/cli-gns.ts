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
import { GNS_PAYMENT_TOKENS, resolveGnsPaymentToken } from '../../plugins/gns/constants';
import { x402PayOrderAction } from '../../plugins/gns/actions/x402-pay-order';
import { x402SubmitSignatureAction } from '../../plugins/gns/actions/x402-submit-signature';
import { EvmPayerWalletAdapter } from '../../plugins/x402/adapters/evm-payer-wallet';
import { JsonRpcProvider, Wallet } from 'ethers';
import { labelhash } from 'viem';
import { assertValidName, normalizeGoatName, ZERO_ADDRESS } from '../../plugins/gns/constants';
import { BASE_REGISTRAR_ABI } from '../../plugins/gns/adapters/contracts';

interface GlobalOpts {
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

/**
 * GNS runs on GOAT Network mainnet. The testnet variant is intentionally
 * not exposed by this CLI — the SDK still supports it for programmatic use.
 */
const GNS_NETWORK = 'goat-mainnet' as const;

function getApi(globals: GlobalOpts) {
  return new HttpGnsApiAdapter({
    baseUrl: globals.apiBaseUrl ?? process.env.GNS_API_BASE_URL,
    network: GNS_NETWORK,
  });
}

export async function runGnsCli(argv: readonly string[]): Promise<ExitCode> {
  loadEnvFromCwd();

  const program = new Command();
  program
    .name(GNS_CLI_METADATA.bin)
    .description(GNS_CLI_METADATA.summary)
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
        network: GNS_NETWORK,
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
        network: GNS_NETWORK,
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
        network: GNS_NETWORK,
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
    .action(async (name: string, cmdOpts: { years: string; token: string; tokenContract?: string }) => {
      const globals = getGlobals(program);
      const action = estimatePriceAction(getApi(globals));
      const { result, exitCode } = await runAction(action, {
        network: GNS_NETWORK,
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
    .option('--wait-timeout <sec>', 'Max seconds to poll for the commit reveal window (minCommitmentAge is 60s)', '180')
    .option('--poll-interval <sec>', 'Seconds between commit-readiness polls', '10')
    .action(
      async (
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
        const networkKey = GNS_NETWORK;
        const contracts = getGnsContracts(networkKey);
        const api = getApi(globals);
        const { authWallet: wallet } = createWalletPair({ network: networkKey, allowMock: globals.dryRun === true });
        const years = Number(cmdOpts.years);
        const owner = (cmdOpts.owner ?? (await wallet.getAddress())) as `0x${string}`;

        if (globals.dryRun) {
          emit(
            {
              dryRun: true,
              plan: [
                'estimatePrice',
                'commit',
                'waitForCommitment',
                'register',
                ...(cmdOpts.description || cmdOpts.url || cmdOpts.email ? ['setProfileRecords'] : []),
                ...(cmdOpts.reverse ? ['setPrimaryName'] : []),
              ],
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

        // Resolve the payment token symbol -> contract address (or use the
        // explicit --token-contract override). The quote/currency field is a
        // symbol, not an address, so it cannot be used as paymentTokenAddress.
        const resolvedToken = cmdOpts.tokenContract
          ? { address: cmdOpts.tokenContract as `0x${string}` }
          : resolveGnsPaymentToken(networkKey, cmdOpts.token);
        if (!resolvedToken) {
          const known = (GNS_PAYMENT_TOKENS[networkKey] ?? []).map((t) => t.symbol).join(', ') || 'none';
          status(
            'error',
            `unknown payment token "${cmdOpts.token}" on ${networkKey}; pass --token-contract <address> (known: ${known})`,
          );
          process.exitCode = ExitCodes.USER_INPUT;
          return;
        }
        const paymentTokenAddress = resolvedToken.address;
        const paymentTokenSymbol = cmdOpts.token;

        // Quote price (with the resolved token so the fee matches).
        const quote = await runAction(estimatePriceAction(api), {
          network: networkKey,
          input: { name, years, tokenContract: paymentTokenAddress },
          format: fmt,
        });
        if (!quote.result.ok || !quote.result.output) {
          reportResult(quote.result, fmt);
          process.exitCode = quote.exitCode;
          return;
        }
        const quoteOut = quote.result.output as { currency: string; totalWei: string };
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
          reportResult(commit, fmt, { revealAll: globals.revealSecrets });
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
        reportResult(commit, fmt, { revealAll: globals.revealSecrets });

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
          status(
            'info',
            `commit not yet revealable; polling again in ${pollIntervalMs / 1000}s (timeout in ${remaining}s)`,
          );
          await new Promise((r) => setTimeout(r, Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()))));
        }
        reportResult(lastWait!.result, fmt);
        if (!ready) {
          status(
            'error',
            `commit reveal window did not open within ${cmdOpts.waitTimeout}s; re-run register (the commit persists on-chain up to maxCommitmentAge)`,
          );
          process.exitCode = ExitCodes.CHAIN_OR_STATE;
          return;
        }

        // Approve the registrar to pull the payment token (register reverts with
        // INVALID_INPUT on insufficient allowance, and the action does not
        // self-approve). Skip when paying via permit (not wired in the CLI yet).
        try {
          status('info', `approving ${paymentTokenSymbol} ${amountWei} to controller ${contracts.controller}`);
          const appr = await wallet.approveErc20(paymentTokenAddress, contracts.controller, amountWei);
          status('info', `approve tx: ${appr.txHash}`);
        } catch (err) {
          status('error', `ERC-20 approve failed: ${(err as Error).message}`);
          process.exitCode = ExitCodes.ADAPTER;
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
      },
    );

  // -- renew -----------------------------------------------------------------
  program
    .command('renew <name>')
    .description('Renew a .goat name')
    .option('--years <n>', 'Years to extend', '1')
    .option('--token <symbol>', 'Payment token symbol', 'USDC')
    .option('--token-contract <address>', 'Override payment token contract')
    .option('--amount-wei <wei>', 'Override max payment amount')
    .action(
      async (name: string, cmdOpts: { years: string; token: string; tokenContract?: string; amountWei?: string }) => {
        const globals = getGlobals(program);
        const fmt = format(globals);
        const networkKey = GNS_NETWORK;
        const contracts = getGnsContracts(networkKey);
        const api = getApi(globals);
        const { authWallet: wallet } = createWalletPair({ network: networkKey, allowMock: globals.dryRun === true });

        const years = Number(cmdOpts.years);
        // Input-bounds validation BEFORE any chain spend. Mirrors
        // the renewAction's Zod schema (years: 1..10, amountWei:
        // /^\d+$/). Without these checks here, `--years 11
        // --amount-wei 1` would pass the early CLI plumbing, take
        // the approve tx (the first non-trivial on-chain spend),
        // and only THEN fail inside the action's Zod validation.
        if (!Number.isInteger(years) || years < 1 || years > 10) {
          status('error', `--years must be an integer in [1,10], got: ${cmdOpts.years}`);
          process.exitCode = ExitCodes.USER_INPUT;
          return;
        }
        if (cmdOpts.amountWei !== undefined && !/^\d+$/.test(cmdOpts.amountWei)) {
          status('error', `--amount-wei must be a positive base-10 integer string, got: ${cmdOpts.amountWei}`);
          process.exitCode = ExitCodes.USER_INPUT;
          return;
        }
        let amountWei = cmdOpts.amountWei;
        // Resolve token symbol -> address (or use the explicit override).
        const resolvedToken = cmdOpts.tokenContract
          ? { address: cmdOpts.tokenContract as `0x${string}` }
          : resolveGnsPaymentToken(networkKey, cmdOpts.token);
        if (!resolvedToken) {
          const known = (GNS_PAYMENT_TOKENS[networkKey] ?? []).map((t) => t.symbol).join(', ') || 'none';
          status(
            'error',
            `unknown payment token "${cmdOpts.token}" on ${networkKey}; pass --token-contract <address> (known: ${known})`,
          );
          process.exitCode = ExitCodes.USER_INPUT;
          return;
        }
        const tokenAddress = resolvedToken.address;

        // Preflight BEFORE we approve, since approve is the first
        // non-trivial on-chain spend in this path. The renewAction
        // itself also validates name shape and checks ownership
        // (plugins/gns/actions/renew.ts:78-97), but doing it inside
        // the action would have the agent pay an approve tx before
        // discovering it doesn't own the name — defeating the
        // purpose of the in-action guard.
        //
        // The checks below match the action's own validation:
        //   1. assertValidName() throws AgentkitRuntimeError(INVALID_INPUT)
        //      on malformed names.
        //   2. baseRegistrar.ownerOf(labelhash(label)) === caller.
        try {
          const { fullName, label: preflightLabel } = normalizeGoatName(name);
          assertValidName(fullName);
          const tokenId = BigInt(labelhash(preflightLabel));
          const ownerRaw = await wallet.callContract(
            contracts.baseRegistrar,
            BASE_REGISTRAR_ABI as unknown as string[],
            'ownerOf',
            [tokenId],
          );
          const renewOwner = String(ownerRaw ?? ZERO_ADDRESS).toLowerCase();
          const caller = (await wallet.getAddress()).toLowerCase();
          if (renewOwner === ZERO_ADDRESS || renewOwner !== caller) {
            status(
              'error',
              `caller is not the name owner (name="${fullName}", owner=${renewOwner}, caller=${caller})`,
            );
            process.exitCode = ExitCodes.POLICY_BLOCKED;
            return;
          }
        } catch (err) {
          // assertValidName / callContract surface AgentkitRuntimeError
          // or plain Error here; map appropriately.
          const message = err instanceof Error ? err.message : String(err);
          status('error', `renew preflight failed: ${message}`);
          process.exitCode = message.includes('Invalid GNS name')
            ? ExitCodes.USER_INPUT
            : ExitCodes.ADAPTER;
          return;
        }

        if (!amountWei) {
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
          amountWei = q.totalWei;
        }

        // Approve the registrar to pull the payment token. The renew
        // action (like register) requires an existing allowance and does
        // NOT self-approve, so the CLI must do it explicitly. We are
        // only here AFTER the preflight above confirmed the name is
        // owned by us — so this approve will only be paid on a renew
        // that will actually succeed.
        try {
          status('info', `approving ${cmdOpts.token} ${amountWei} to controller ${contracts.controller}`);
          const appr = await wallet.approveErc20(tokenAddress, contracts.controller, amountWei);
          status('info', `approve tx: ${appr.txHash}`);
        } catch (err) {
          status('error', `ERC-20 approve failed: ${(err as Error).message}`);
          process.exitCode = ExitCodes.ADAPTER;
          return;
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
      },
    );

  // -- set-records -----------------------------------------------------------
  program
    .command('set-records <name>')
    .description('Set resolver text records')
    .option('--description <text>', 'Set description text record')
    .option('--url <text>', 'Set url text record')
    .option('--email <text>', 'Set email text record')
    .option('--text <pair...>', 'Arbitrary key=value records', collectKv, [] as Array<{ key: string; value: string }>)
    .action(
      async (
        name: string,
        cmdOpts: { description?: string; url?: string; email?: string; text?: Array<{ key: string; value: string }> },
      ) => {
        const globals = getGlobals(program);
        const fmt = format(globals);
        const networkKey = GNS_NETWORK;
        const contracts = getGnsContracts(networkKey);
        const { authWallet: wallet } = createWalletPair({ network: networkKey, allowMock: globals.dryRun === true });

        const records: Array<{ key: string; value: string }> = [];
        if (cmdOpts.description) records.push({ key: 'description', value: cmdOpts.description });
        if (cmdOpts.url) records.push({ key: 'url', value: cmdOpts.url });
        if (cmdOpts.email) records.push({ key: 'email', value: cmdOpts.email });
        if (cmdOpts.text) records.push(...cmdOpts.text);
        if (!records.length) {
          status(
            'error',
            'no records supplied; pass at least one of --description / --url / --email / --text key=value',
          );
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
      },
    );

  // -- set-primary -----------------------------------------------------------
  program
    .command('set-primary <name>')
    .description("Set the caller's primary .goat name")
    .option('--address <address>', 'Address to set primary for (defaults to wallet)')
    .action(async (name: string, _cmdOpts: { address?: string }) => {
      const globals = getGlobals(program);
      const fmt = format(globals);
      const networkKey = GNS_NETWORK;
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
    .action(
      async (
        name: string,
        cmdOpts: { years: string; payChain: string; payToken: string; payTokenContract?: string },
      ) => {
        const globals = getGlobals(program);
        const fmt = format(globals);
        const networkKey = GNS_NETWORK;
        const contracts = getGnsContracts(networkKey);
        const api = getApi(globals);

        const payChainId = Number(cmdOpts.payChain);
        if (!Number.isSafeInteger(payChainId) || payChainId <= 0) {
          status('error', `invalid --pay-chain: ${cmdOpts.payChain} (expected a positive chain id)`);
          process.exitCode = ExitCodes.USER_INPUT;
          return;
        }

        if (globals.dryRun) {
          emit(
            {
              dryRun: true,
              plan: ['commit', 'x402.createOrder', 'x402.submitSignature', 'x402.payOrder', 'x402.getOrderStatus'],
              name,
              years: Number(cmdOpts.years),
              payChain: payChainId,
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
          status(
            'error',
            'x402-register requires GOAT_PRIVATE_KEY, PAYMENT_CHAIN_RPC_URL, PAYMENT_CHAIN_PRIVATE_KEY, and --pay-token-contract',
          );
          process.exitCode = ExitCodes.USER_INPUT;
          return;
        }

        // Validate --pay-token-contract shape BEFORE the GOAT commit tx
        // fires. x402-create-order's Zod schema validates this, but by
        // then we've already burned a `commit(...)` on the GOAT chain.
        // Refuse early on a malformed address.
        if (!/^0x[0-9a-fA-F]{40}$/.test(cmdOpts.payTokenContract)) {
          status(
            'error',
            `--pay-token-contract must be a 40-hex EVM address, got: ${cmdOpts.payTokenContract}`,
          );
          process.exitCode = ExitCodes.USER_INPUT;
          return;
        }
        const yearsX402 = Number(cmdOpts.years);
        if (!Number.isInteger(yearsX402) || yearsX402 < 1 || yearsX402 > 10) {
          status('error', `--years must be an integer in [1,10], got: ${cmdOpts.years}`);
          process.exitCode = ExitCodes.USER_INPUT;
          return;
        }

        const goatPair = createWalletPair({ network: networkKey, allowMock: false });
        const goatWallet = goatPair.authWallet;
        const sourceWallet = goatPair.paymentWallet;

        // Preflight the source wallet is actually on the chain the user
        // declared via --pay-chain. x402-pay-order checks this, but by
        // then the GOAT commit + x402 order + signature have all been
        // submitted. Catching the mismatch up-front saves the user from
        // wasting a commit on the wrong source-chain RPC.
        if (typeof sourceWallet.getChainId === 'function') {
          try {
            const sourceChainId = await sourceWallet.getChainId();
            if (sourceChainId !== payChainId) {
              status(
                'error',
                `chain_mismatch: PAYMENT_CHAIN_RPC_URL reports chain ${sourceChainId}, but --pay-chain is ${payChainId}; reconcile before retrying`,
              );
              process.exitCode = ExitCodes.CHAIN_OR_STATE;
              return;
            }
          } catch (err) {
            status(
              'error',
              `failed to read source wallet chainId: ${(err as Error).message}`,
            );
            process.exitCode = ExitCodes.ADAPTER;
            return;
          }
        }

        const goatPayer = new EvmPayerWalletAdapter(new Wallet(goatPrivateKey, new JsonRpcProvider(goatRpc)));
        const sourcePayer = new EvmPayerWalletAdapter(new Wallet(sourcePrivateKey, new JsonRpcProvider(sourceRpc)));

        // Use a single ActionProvider so we can route across networks.
        const provider = new ActionProvider();
        provider.register(commitAction(contracts, goatWallet));
        provider.register(x402CreateOrderAction(api));
        provider.register(x402SubmitSignatureAction(api, goatPayer));
        provider.register(x402PayOrderAction(api, sourcePayer, sourceWallet));
        provider.register(x402GetOrderStatusAction(api));

        const policy = new PolicyEngine({
          allowedNetworks: [networkKey, 'payment-chain', `evm-${payChainId}`],
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

        const commitActionDef = provider.get('goat.gns.commit');
        const commit = await runtime.run(
          commitActionDef,
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
        // The runtime never redacts result.output; the CLI must, otherwise
        // `--reveal-secrets` would be a no-op and the secret would always
        // print in the clear.
        reportResult(commit, fmt, {
          sensitiveOutputFields: commitActionDef.sensitiveOutputFields,
          revealAll: globals.revealSecrets,
        });
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
            settlementChainId: payChainId,
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

        const sourceCtx: ActionContext = { ...baseCtx, network: `evm-${payChainId}` };
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

        const statusRes = await runtime.run(provider.get('goat.gns.x402.getOrderStatus'), baseCtx, {
          orderId: orderOut.orderId,
        });
        reportResult(statusRes, fmt);
        process.exitCode = statusRes.ok ? ExitCodes.SUCCESS : classifyExitCode(statusRes.errorCode, statusRes.error);
      },
    );

  // -- doctor ----------------------------------------------------------------
  program
    .command('doctor')
    .description('Diagnose env vars, API connectivity, and wallet config')
    .action(async () => {
      const globals = getGlobals(program);
      const fmt = format(globals);
      const apiUrl = globals.apiBaseUrl ?? process.env.GNS_API_BASE_URL ?? 'https://gns-api.goat.network/api';
      const report = await runDoctor({
        envVars: [
          { name: 'GNS_API_BASE_URL', required: false },
          { name: 'GOAT_PRIVATE_KEY', required: false },
          { name: 'GOAT_MAINNET_RPC_URL', required: false },
        ],
        apiUrl,
        network: GNS_NETWORK,
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
