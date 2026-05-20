/**
 * The agentkit-giftcard CLI implementation. Loaded by `bin/giftcard.mjs`
 * via `tsx/esm/api` so the bin shim stays as a tiny `.mjs` shebang.
 */
import { Command } from 'commander';
import {
  ExitCodes,
  type ExitCode,
  loadEnvFromCwd,
  runAction,
  reportResult,
  handleCaughtError,
} from './command-runner';
import { emit, status } from './output';
import { confirm } from './confirmations';
import { createWalletPair } from './wallet-from-env';
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
import { randomUUID } from 'node:crypto';

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

function buildGateway(globals: GlobalOpts) {
  // authWallet signs the off-chain EIP-712 auth (domain chainId is fixed, so
  // its connected chain is irrelevant). paymentWallet is the one that must be
  // on the chosen --pay-chain for the on-chain ERC-20 transfer in payOrder;
  // it comes from PAYMENT_CHAIN_RPC_URL / PAYMENT_CHAIN_ID / PAYMENT_CHAIN_PRIVATE_KEY
  // (falling back to the auth wallet for GOAT-native single-signer flows).
  const { authWallet, paymentWallet } = createWalletPair({ network: getNetwork(globals), allowMock: true });
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
    .option('--network <network>', 'goat-mainnet or goat-testnet (default: goat-testnet)', (val) => {
      if (val !== 'goat-mainnet' && val !== 'goat-testnet') {
        throw new Error(`invalid --network value: ${val}`);
      }
      return val;
    })
    .option('--api-base-url <url>', 'Override GIFTCARD_API_BASE_URL')
    .option('--dry-run', 'For buy: validate + show plan, skip on-chain writes')
    .option('--json', 'Emit machine-readable JSON to stdout')
    .option('--quiet', 'No spinners / prompts; fail if a prompt would appear')
    .option('--auto-confirm', 'Skip interactive y/N gates')
    .option('--reveal-secrets', 'Display card_code / card_pin / card_link in the clear (status / list-orders)')
    .exitOverride();

  // -- list-brands -----------------------------------------------------------
  program
    .command('list-brands')
    .description('List giftcard brands')
    .option('--country <iso2>', 'ISO 3166-1 alpha-2 country')
    .option('--category <id>', 'Category id')
    .option('--lang <bcp47>', 'BCP-47 language')
    .action(async (cmdOpts: { country?: string; category?: string; lang?: string }) => {
      const globals = getGlobals(program);
      const { gateway } = buildGateway(globals);
      const { result, exitCode } = await runAction(listBrandsAction(gateway), {
        network: getNetwork(globals),
        input: cmdOpts,
        format: format(globals),
      });
      reportResult(result, format(globals));
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
        network: getNetwork(globals),
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
        network: getNetwork(globals),
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
    .option('--pay-chain <chainId>', 'Payment chain id', '8453')
    .option('--pay-token <symbol>', 'Payment token symbol (USDC or USDT)', 'USDC')
    .option('--poll-timeout-sec <n>', 'Max seconds to poll for fulfillment', '60')
    .action(async (cmdOpts: {
      brand?: string;
      product?: string;
      faceValue: string;
      payChain: string;
      payToken: string;
      pollTimeoutSec: string;
    }) => {
      const globals = getGlobals(program);
      const fmt = format(globals);
      const { gateway, paymentWallet } = buildGateway(globals);
      const networkKey = getNetwork(globals);
      const faceValue = Number(cmdOpts.faceValue);
      const payChain = Number(cmdOpts.payChain);
      const payToken = cmdOpts.payToken;
      if (payToken !== 'USDC' && payToken !== 'USDT') {
        status('error', `unsupported --pay-token: ${payToken} (USDC or USDT)`);
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
        emit({
          dryRun: true,
          plan: ['createOrder', 'payOrder', 'poll getOrder until FULFILLED'],
          product: productId,
          faceValue,
          payChain,
          payToken,
        }, fmt);
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
      status('warn', `order not fulfilled within ${cmdOpts.pollTimeoutSec}s (last status: ${lastStatus ?? 'unknown'})`);
      process.exitCode = ExitCodes.UNKNOWN;
    });

  // -- status ----------------------------------------------------------------
  program
    .command('status <orderId>')
    .description('Read a single order')
    .action(async (orderId: string) => {
      const globals = getGlobals(program);
      const fmt = format(globals);
      const { gateway } = buildGateway(globals);
      const networkKey = getNetwork(globals);

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
      const networkKey = getNetwork(globals);
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
      const apiUrl =
        globals.apiBaseUrl ??
        process.env.GIFTCARD_API_BASE_URL ??
        'https://giftcard-api.goat.network';
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
        network: getNetwork(globals),
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
