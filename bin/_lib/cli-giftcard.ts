/**
 * The agentkit-giftcard CLI implementation. Loaded by `bin/giftcard.mjs`
 * via `tsx/esm/api` so the bin shim stays as a tiny `.mjs` shebang.
 */
import { Command } from 'commander';
import { ExitCodes, type ExitCode, loadEnvFromCwd, runAction, reportResult, handleCaughtError } from './command-runner';
import { emit, status } from './output';
import { confirm, select } from './confirmations';
import { createWalletPair } from './wallet-from-env';
import { discoverRegions } from './regions';
import { runDoctor } from './doctor';
import { GIFTCARD_CLI_METADATA } from './commands/giftcard/metadata';
import {
  HttpGiftcardGatewayAdapter,
  Eip712AuthSigner,
  createOrderAction,
  getBrandAction,
  getOrderAction,
  listBrandsAction,
  listOrdersAction,
  listSupportedTokensAction,
  payOrderAction,
} from '../../plugins/giftcard/index';
import { printSecretAction } from '../../core/actions/print-secret';
import { NoopWalletProvider } from '../../core/wallet/noop-wallet-provider';
import { randomUUID } from 'node:crypto';

interface GlobalOpts {
  apiBaseUrl?: string;
  dryRun?: boolean;
  json?: boolean;
  quiet?: boolean;
  autoConfirm?: boolean;
  revealSecrets?: boolean;
}

/**
 * Giftcard runs only on GOAT Network: the EIP-712 auth domain chainId is
 * fixed (2345) and the gateway is mainnet-only, so there is no testnet
 * variant to choose. The (off-chain) auth wallet always connects here.
 */
const GIFTCARD_NETWORK = 'goat-mainnet' as const;

/** Default payment chain when the user does not pick one: GOAT (chainId 2345). */
const DEFAULT_PAY_CHAIN_ID = 2345;

function getGlobals(cmd: Command): GlobalOpts {
  let cursor: Command | null = cmd;
  while (cursor && cursor.parent) cursor = cursor.parent;
  return (cursor?.opts() as GlobalOpts) ?? {};
}

function format(globals: GlobalOpts): 'json' | 'human' {
  return globals.json ? 'json' : 'human';
}

/** Whether stdin/stdout are interactive and prompting is allowed. */
function isInteractive(globals: GlobalOpts): boolean {
  return !globals.quiet && !globals.json && process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/**
 * Report a CLI input error respecting the output format: JSON mode emits a
 * structured `{ ok:false, errorCode, error }` to stdout so machine pipelines
 * still get parseable output; human mode prints to stderr.
 */
function emitError(fmt: 'json' | 'human', message: string, errorCode = 'INVALID_INPUT'): void {
  if (fmt === 'json') emit({ ok: false, errorCode, error: message }, fmt);
  else status('error', message);
}

function buildGateway(globals: GlobalOpts) {
  // authWallet signs the off-chain EIP-712 auth (domain chainId is fixed, so
  // its connected chain is irrelevant). paymentWallet is the one that must be
  // on the chosen --pay-chain for the on-chain ERC-20 transfer in payOrder;
  // it comes from PAYMENT_CHAIN_RPC_URL / PAYMENT_CHAIN_ID / PAYMENT_CHAIN_PRIVATE_KEY
  // (falling back to the auth wallet for GOAT-native single-signer flows).
  const { authWallet, paymentWallet } = createWalletPair({ network: GIFTCARD_NETWORK, allowMock: true });
  const authSigner = new Eip712AuthSigner(authWallet);
  const gateway = new HttpGiftcardGatewayAdapter({
    baseUrl: globals.apiBaseUrl ?? process.env.GIFTCARD_API_BASE_URL,
    authSigner,
  });
  return { gateway, authWallet, paymentWallet };
}

export async function runGiftcardCli(argv: readonly string[]): Promise<ExitCode> {
  loadEnvFromCwd();

  const program = new Command();
  program
    .name(GIFTCARD_CLI_METADATA.bin)
    .description(GIFTCARD_CLI_METADATA.summary)
    .option('--api-base-url <url>', 'Override GIFTCARD_API_BASE_URL')
    .option('--dry-run', 'For buy: validate + show plan, skip on-chain writes')
    .option('--json', 'Emit machine-readable JSON to stdout')
    .option('--quiet', 'No spinners / prompts; fail if a prompt would appear')
    .option('--auto-confirm', 'Skip interactive y/N gates')
    .option('--reveal-secrets', 'Display card_code / card_pin / card_link in the clear (status / list-orders)')
    .exitOverride();

  // -- regions ---------------------------------------------------------------
  program
    .command('regions')
    .description('Discover live giftcard regions (probes the brand catalog)')
    .action(async () => {
      const globals = getGlobals(program);
      const fmt = format(globals);
      const { gateway } = buildGateway(globals);
      try {
        const regions = await discoverRegions(gateway);
        emit({ regions }, fmt);
        process.exitCode = ExitCodes.SUCCESS;
      } catch (err) {
        status('error', `region discovery failed: ${(err as Error).message}`);
        process.exitCode = ExitCodes.ADAPTER;
      }
    });

  // -- list-brands -----------------------------------------------------------
  program
    .command('list-brands')
    .description('List giftcard brands')
    .option('--country <iso2>', 'ISO 3166-1 alpha-2 country (e.g. US, CA)')
    .option('--category <id>', 'Category id')
    .option('--lang <bcp47>', 'BCP-47 language')
    .action(async (cmdOpts: { country?: string; category?: string; lang?: string }) => {
      const globals = getGlobals(program);
      const fmt = format(globals);
      const { gateway } = buildGateway(globals);

      // Require an explicit region. The API silently defaults to US, which
      // hides other catalogs (e.g. CA), so we force a choice.
      let country = cmdOpts.country;
      if (!country) {
        if (isInteractive(globals)) {
          const regions = await discoverRegions(gateway);
          if (regions.length === 0) {
            status('error', 'no regions discovered from the gateway; pass --country <iso2>');
            process.exitCode = ExitCodes.ADAPTER;
            return;
          }
          const defaultIndex = Math.max(
            0,
            regions.findIndex((r) => r.code === 'US'),
          );
          country = await select(
            'Select a region',
            regions.map((r) => ({ label: `${r.code}  ${r.name} (${r.brandCount} brands)`, value: r.code })),
            { defaultIndex, autoConfirm: globals.autoConfirm, quiet: globals.quiet },
          );
        } else {
          emitError(
            fmt,
            '--country is required; run `agentkit-giftcard regions` to list supported regions (e.g. US, CA)',
          );
          process.exitCode = ExitCodes.USER_INPUT;
          return;
        }
      }

      const { result, exitCode } = await runAction(listBrandsAction(gateway), {
        network: GIFTCARD_NETWORK,
        input: { country, category: cmdOpts.category, lang: cmdOpts.lang },
        format: fmt,
      });
      reportResult(result, fmt);
      process.exitCode = exitCode;
    });

  // -- get-brand -------------------------------------------------------------
  program
    .command('get-brand <brandId>')
    .description('Read brand + products')
    .option('--lang <bcp47>', 'BCP-47 language', 'en')
    .action(async (brandId: string, cmdOpts: { lang: string }) => {
      const globals = getGlobals(program);
      const { gateway } = buildGateway(globals);
      const { result, exitCode } = await runAction(getBrandAction(gateway), {
        network: GIFTCARD_NETWORK,
        input: { brand_id: brandId, lang: cmdOpts.lang },
        format: format(globals),
      });
      reportResult(result, format(globals));
      process.exitCode = exitCode;
    });

  // -- list-chains -----------------------------------------------------------
  program
    .command('list-chains')
    .description('List supported payment chains + tokens')
    .action(async () => {
      const globals = getGlobals(program);
      const { gateway } = buildGateway(globals);
      const { result, exitCode } = await runAction(listSupportedTokensAction(gateway), {
        network: GIFTCARD_NETWORK,
        input: {},
        format: format(globals),
      });
      reportResult(result, format(globals));
      process.exitCode = exitCode;
    });

  // -- buy -------------------------------------------------------------------
  program
    .command('buy')
    .description('Buy a giftcard (createOrder → payOrder → poll until FULFILLED)')
    .option('--brand <id>', 'Brand UUID')
    .option('--product <id>', 'Product UUID (skips brand lookup)')
    .option('--face-value <amount>', 'Face value', '50')
    .option('--pay-chain <chainId>', 'Payment chain id (default: GOAT 2345; omit to pick interactively)')
    .option('--pay-token <symbol>', 'Payment token symbol (USDC or USDT)', 'USDC')
    .option('--poll-timeout-sec <n>', 'Max seconds to poll for fulfillment', '60')
    .action(
      async (cmdOpts: {
        brand?: string;
        product?: string;
        faceValue: string;
        payChain?: string;
        payToken: string;
        pollTimeoutSec: string;
      }) => {
        const globals = getGlobals(program);
        const fmt = format(globals);
        const { gateway, authWallet, paymentWallet } = buildGateway(globals);
        const networkKey = GIFTCARD_NETWORK;
        const faceValue = Number(cmdOpts.faceValue);
        const payToken = cmdOpts.payToken;
        if (payToken !== 'USDC' && payToken !== 'USDT') {
          status('error', `unsupported --pay-token: ${payToken} (USDC or USDT)`);
          process.exitCode = ExitCodes.USER_INPUT;
          return;
        }

        // `buy` is a real-money write. Refuse to run with a mock wallet (no key)
        // unless dry-running or DEMO_MOCK is explicitly set — a NoopWalletProvider
        // would otherwise pass the chain precheck and return a fake payOrder tx.
        if (
          !globals.dryRun &&
          process.env.DEMO_MOCK !== 'true' &&
          (authWallet instanceof NoopWalletProvider || paymentWallet instanceof NoopWalletProvider)
        ) {
          emitError(
            fmt,
            'buy requires a real wallet: set GOAT_PRIVATE_KEY (and PAYMENT_CHAIN_RPC_URL / PAYMENT_CHAIN_ID / PAYMENT_CHAIN_PRIVATE_KEY for non-GOAT chains), or use --dry-run',
          );
          process.exitCode = ExitCodes.USER_INPUT;
          return;
        }

        // Resolve the payment chain. Explicit --pay-chain wins; otherwise pick
        // interactively from the live supported-chains list, or default to
        // GOAT (2345) when prompting is not possible.
        let payChain: number;
        if (cmdOpts.payChain != null) {
          payChain = Number(cmdOpts.payChain);
          if (!Number.isSafeInteger(payChain) || payChain <= 0) {
            emitError(fmt, `invalid --pay-chain: ${cmdOpts.payChain} (expected a positive chain id)`);
            process.exitCode = ExitCodes.USER_INPUT;
            return;
          }
        } else if (isInteractive(globals)) {
          // Pick interactively from the chains that actually support the chosen
          // token. Fail closed if discovery fails — never silently default to
          // GOAT, since that would build a real payment plan the user did not
          // choose.
          const tokensRes = await runAction(listSupportedTokensAction(gateway), {
            network: networkKey,
            input: {},
            format: fmt,
          });
          if (!tokensRes.result.ok || !tokensRes.result.output) {
            reportResult(tokensRes.result, fmt);
            status('error', 'could not load supported chains; pass --pay-chain <id> explicitly');
            process.exitCode = tokensRes.exitCode;
            return;
          }
          const tokens = (
            tokensRes.result.output as {
              tokens: Array<{ chain_id: number; chain_name?: string; token_symbol: string }>;
            }
          ).tokens;
          const seen = new Set<number>();
          const chains = tokens
            .filter((t) => t.token_symbol === payToken)
            .filter((t) => !seen.has(t.chain_id) && (seen.add(t.chain_id), true))
            .map((t) => ({
              label: `${t.chain_name ?? `chain ${t.chain_id}`} (${t.chain_id})`,
              value: t.chain_id,
            }));
          if (chains.length === 0) {
            emitError(fmt, `no supported chains offer ${payToken}; pass --pay-chain <id> explicitly`);
            process.exitCode = ExitCodes.USER_INPUT;
            return;
          }
          const defaultIndex = Math.max(
            0,
            chains.findIndex((c) => c.value === DEFAULT_PAY_CHAIN_ID),
          );
          payChain = await select(`Select a payment chain for ${payToken}`, chains, {
            defaultIndex,
            autoConfirm: globals.autoConfirm,
            quiet: globals.quiet,
          });
        } else {
          payChain = DEFAULT_PAY_CHAIN_ID;
        }

        // A non-GOAT pay-chain needs the caller's own RPC for that chain.
        if (payChain !== DEFAULT_PAY_CHAIN_ID && !process.env.PAYMENT_CHAIN_RPC_URL) {
          status(
            'error',
            `paying on chain ${payChain} requires PAYMENT_CHAIN_RPC_URL (+ PAYMENT_CHAIN_ID / PAYMENT_CHAIN_PRIVATE_KEY) for that chain`,
          );
          process.exitCode = ExitCodes.USER_INPUT;
          return;
        }

        // Resolve a product id from --product or --brand.
        let productId = cmdOpts.product;
        if (!productId) {
          if (!cmdOpts.brand) {
            status('error', 'pass --brand <id> or --product <id>');
            process.exitCode = ExitCodes.USER_INPUT;
            return;
          }
          const brandRes = await runAction(getBrandAction(gateway), {
            network: networkKey,
            input: { brand_id: cmdOpts.brand, lang: 'en' },
            format: fmt,
          });
          if (!brandRes.result.ok || !brandRes.result.output) {
            reportResult(brandRes.result, fmt);
            process.exitCode = brandRes.exitCode;
            return;
          }
          const brand = brandRes.result.output as { products: Array<{ product_id: string }> };
          if (!brand.products?.length) {
            status('error', 'brand has no products');
            process.exitCode = ExitCodes.USER_INPUT;
            return;
          }
          productId = brand.products[0].product_id;
        }

        if (globals.dryRun) {
          emit(
            {
              dryRun: true,
              plan: ['createOrder', 'payOrder', 'poll getOrder until FULFILLED'],
              product: productId,
              faceValue,
              payChain,
              payToken,
            },
            fmt,
          );
          process.exitCode = ExitCodes.SUCCESS;
          return;
        }

        if (!globals.autoConfirm) {
          const okay = await confirm(`Buy a ${faceValue} ${payToken} giftcard? (chain=${payChain})`, {
            autoConfirm: globals.autoConfirm,
            quiet: globals.quiet,
          });
          if (!okay) {
            status('warn', 'aborted by user');
            process.exitCode = ExitCodes.USER_INPUT;
            return;
          }
        }

        // Verify the payment wallet can reach the selected chain before we
        // create a real order (surfaces RPC / chain-mismatch issues early
        // rather than failing deep inside payOrder).
        try {
          const walletChainId = await paymentWallet.getChainId();
          if (walletChainId !== payChain) {
            status(
              'error',
              `payment wallet is on chain ${walletChainId}, but the selected pay-chain is ${payChain}; check PAYMENT_CHAIN_RPC_URL / PAYMENT_CHAIN_ID`,
            );
            process.exitCode = ExitCodes.CHAIN_OR_STATE;
            return;
          }
          status('info', `payment chain ${payChain} reachable`);
        } catch (err) {
          status('error', `failed to reach payment chain RPC: ${(err as Error).message}`);
          process.exitCode = ExitCodes.ADAPTER;
          return;
        }

        // createOrder
        const idempotencyKey = randomUUID();
        const createRes = await runAction(createOrderAction(gateway), {
          network: networkKey,
          input: {
            product_id: productId,
            face_value: faceValue,
            pay_chain_id: payChain,
            pay_token_symbol: payToken,
            idempotency_key: idempotencyKey,
          },
          executionOptions: { confirmed: true, idempotencyKey },
          format: fmt,
        });
        if (!createRes.result.ok || !createRes.result.output) {
          reportResult(createRes.result, fmt);
          process.exitCode = createRes.exitCode;
          return;
        }
        const orderOut = createRes.result.output as { order_id: string };
        reportResult(createRes.result, fmt);

        // payOrder
        const payRes = await runAction(payOrderAction(gateway, paymentWallet), {
          network: networkKey,
          input: { orderId: orderOut.order_id },
          executionOptions: { confirmed: true },
          format: fmt,
        });
        reportResult(payRes.result, fmt);
        if (payRes.exitCode !== ExitCodes.SUCCESS) {
          process.exitCode = payRes.exitCode;
          return;
        }

        // Poll getOrder until FULFILLED.
        const deadline = Date.now() + Number(cmdOpts.pollTimeoutSec) * 1000;
        let lastStatus: string | undefined;
        while (Date.now() < deadline) {
          const getRes = await runAction(getOrderAction(gateway), {
            network: networkKey,
            input: { orderId: orderOut.order_id },
            format: fmt,
          });
          if (!getRes.result.ok) {
            reportResult(getRes.result, fmt);
            process.exitCode = getRes.exitCode;
            return;
          }
          const order = getRes.result.output as { status: string; card_code?: string };
          lastStatus = order.status;
          if (order.status === 'FULFILLED') {
            reportResult(getRes.result, fmt);
            if (globals.revealSecrets && order.card_code) {
              await runAction(printSecretAction(), {
                network: networkKey,
                input: { value: order.card_code, label: 'card_code' },
                executionOptions: { revealedFields: ['value'] },
                format: fmt,
              });
            }
            process.exitCode = ExitCodes.SUCCESS;
            return;
          }
          if (order.status === 'CANCELLED' || order.status === 'REFUNDED' || order.status === 'FAILED') {
            reportResult(getRes.result, fmt);
            process.exitCode = ExitCodes.CHAIN_OR_STATE;
            return;
          }
          await new Promise((r) => setTimeout(r, 2_000));
        }
        status(
          'warn',
          `order not fulfilled within ${cmdOpts.pollTimeoutSec}s (last status: ${lastStatus ?? 'unknown'})`,
        );
        process.exitCode = ExitCodes.UNKNOWN;
      },
    );

  // -- status ----------------------------------------------------------------
  program
    .command('status <orderId>')
    .description('Read a single order')
    .action(async (orderId: string) => {
      const globals = getGlobals(program);
      const fmt = format(globals);
      const { gateway } = buildGateway(globals);
      const networkKey = GIFTCARD_NETWORK;

      const { result, exitCode } = await runAction(getOrderAction(gateway), {
        network: networkKey,
        input: { orderId },
        executionOptions: globals.revealSecrets
          ? { revealedFields: ['card_code', 'card_pin', 'card_link', 'card_barcode'] }
          : undefined,
        format: fmt,
      });
      reportResult(result, fmt);
      process.exitCode = exitCode;
    });

  // -- list-orders -----------------------------------------------------------
  program
    .command('list-orders')
    .description("List the authenticated wallet's orders")
    .option('--status <status>', 'Filter by order status')
    .option('--limit <n>', 'Page size', '50')
    .option('--offset <n>', 'Pagination offset', '0')
    .action(async (cmdOpts: { status?: string; limit: string; offset: string }) => {
      const globals = getGlobals(program);
      const fmt = format(globals);
      const { gateway } = buildGateway(globals);
      const networkKey = GIFTCARD_NETWORK;
      const { result, exitCode } = await runAction(listOrdersAction(gateway), {
        network: networkKey,
        input: {
          status: cmdOpts.status,
          limit: Number(cmdOpts.limit),
          offset: Number(cmdOpts.offset),
        },
        executionOptions: globals.revealSecrets
          ? { revealedFields: ['card_code', 'card_pin', 'card_link', 'card_barcode'] }
          : undefined,
        format: fmt,
      });
      reportResult(result, fmt);
      process.exitCode = exitCode;
    });

  // -- doctor ----------------------------------------------------------------
  program
    .command('doctor')
    .description('Diagnose env vars, API connectivity, and wallet config')
    .action(async () => {
      const globals = getGlobals(program);
      const fmt = format(globals);
      const apiUrl = globals.apiBaseUrl ?? process.env.GIFTCARD_API_BASE_URL ?? 'https://giftcard-api.goat.network';
      const report = await runDoctor({
        envVars: [
          { name: 'GIFTCARD_API_BASE_URL', required: false },
          { name: 'GIFTCARD_AUTH_DOMAIN_NAME', required: false },
          { name: 'GIFTCARD_AUTH_DOMAIN_VERSION', required: false },
          { name: 'GIFTCARD_AUTH_DOMAIN_CHAIN_ID', required: false },
          { name: 'GOAT_PRIVATE_KEY', required: false },
          { name: 'PAYMENT_CHAIN_RPC_URL', required: false },
          { name: 'PAYMENT_CHAIN_PRIVATE_KEY', required: false },
        ],
        apiUrl,
        network: GIFTCARD_NETWORK,
      });
      emit(report, fmt);
      process.exitCode = report.ok ? ExitCodes.SUCCESS : ExitCodes.USER_INPUT;
    });

  try {
    await program.parseAsync(argv as string[], { from: 'node' });
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err) {
      const code = (err as { code?: string }).code ?? '';
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
