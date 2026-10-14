import { Command, CommanderError, InvalidArgumentError } from 'commander';
import { JsonRpcProvider, Wallet, formatUnits } from 'ethers';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EvmWalletProvider } from '../../core/wallet/evm-wallet-provider';
import { AgentkitRuntimeError } from '../../core/errors/error';
import { ErrorCodes } from '../../core/errors/error-codes';
import type { ActionRecovery } from '../../core/schema/action';
import {
  PaykitService,
  createPaykitActions,
  paykitActionDefinitions,
  FilePaymentRecoveryStore,
} from '../../plugins/paykit';
import { confirm, ConfirmationRequiredError } from './confirmations';
import { loadEnvFromCwd, runAction, reportResult } from './command-runner';
import { emit, type OutputFormat } from './output';
import { paykitRecoveryOutput } from './paykit-recovery-output';
import { validateEmergencyDirectory } from './paykit-directories';
import {
  canPreparePayment,
  readPaymentRecovery,
  replayResult,
  type PaymentRecovery,
} from '../../plugins/paykit/recovery';
import { resolvePaymentRequest } from '../../plugins/paykit/journal';
import { paymentTarget } from '../../plugins/paykit/http';
import { formatZodIssues } from '../../core/runtime/schema-validator';
import { isValidTimeout, MAX_TIMEOUT_MS } from '../../core/runtime/timeout';

function positiveInteger(value: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n <= 0)
    throw new InvalidArgumentError('Expected a positive safe integer');
  return n;
}

function timeoutMilliseconds(value: string): number {
  const timeout = positiveInteger(value);
  if (!isValidTimeout(timeout)) throw new InvalidArgumentError(`Timeout must be at most ${MAX_TIMEOUT_MS} ms`);
  return timeout;
}

type MerchantQuote = Awaited<ReturnType<PaykitService['inspect']>>;

/**
 * Resolve a journaled intent as payment execution does, including a request
 * marker that a crash left ahead of its prepared primary. 'unverified' means the
 * stored records themselves are corrupt or conflicting, so execution must stop
 * for reconciliation. Any other failure (such as transient journal I/O) leaves
 * the outcome unknown: undefined keeps the quoted approval for a possible payment.
 */
async function journaledIntent(
  store: FilePaymentRecoveryStore,
  key: string,
): Promise<PaymentRecovery | 'unverified' | undefined> {
  const stored = (error: unknown) =>
    error instanceof AgentkitRuntimeError && error.code === ErrorCodes.RECOVERY_REQUIRED ? 'unverified' : undefined;
  let primary: PaymentRecovery | undefined;
  try {
    primary = await readPaymentRecovery(store, key);
  } catch (error) {
    return stored(error);
  }
  if (!primary) return undefined;
  return resolvePaymentRequest(store, primary).catch(stored);
}

/** Merchant text must not rewrite the approval line with control or bidi characters. */
function merchantText(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, '?').slice(0, 64);
}

/**
 * State what an interactive approval authorizes: the resolved payer key and the
 * terms. Product and MPP prices come from the merchant manifest, so they are
 * quoted before approval; the payment still revalidates them at execution.
 */
async function confirmationSummary(
  name: string,
  input: Record<string, unknown>,
  chainId: number | undefined,
  payer: { address: string; source: string } | undefined,
  quote: () => Promise<MerchantQuote>,
): Promise<string> {
  const url = String(input.url);
  const chain = chainId ? ` on eip155:${chainId}` : '';
  const from = payer ? ` from ${payer.address} (${payer.source})` : '';
  const key = input.idempotencyKey ? `; idempotency key ${String(input.idempotencyKey)}` : '';
  const token = [input.tokenSymbol, input.tokenContract].filter(Boolean).join(' ');
  switch (name) {
    case 'pay':
      return `Pay ${String(input.amount)} ${token}${chain} to ${url}${from}${key}`;
    case 'payProduct': {
      const details = await quote();
      const product = details.x402_products.find((p) => p.product_key === input.productKey);
      const listed = details.x402_tokens.find(
        (t) =>
          t.chain_id === chainId &&
          (input.tokenContract
            ? t.token_contract.toLowerCase() === String(input.tokenContract).toLowerCase()
            : t.token_symbol.toLowerCase() === String(input.tokenSymbol).toLowerCase()),
      );
      const price = product
        ? `${merchantText(product.price)} ${listed ? merchantText(listed.token_symbol) : token}`
        : 'a price the merchant does not currently offer';
      return `Buy product ${String(input.productKey)} for ${price}${chain} from ${url}${from}${key}`;
    }
    case 'payMpp': {
      const details = await quote();
      const route = details.mpp_routes.find((r) => r.route_canonical === input.route);
      const decimals = details.x402_tokens.find(
        (t) => t.chain_id === route?.chain_id && t.token_symbol === route?.token_symbol,
      )?.decimals;
      const amount = !route
        ? 'a route the merchant does not currently offer'
        : decimals === undefined
          ? `${merchantText(route.amount_wei)} base units of ${merchantText(route.token_symbol)}`
          : `${formatUnits(route.amount_wei, decimals)} ${merchantText(route.token_symbol)} (${merchantText(route.amount_wei)} base units)`;
      const cap = input.maxAmountWei ? `; cap ${String(input.maxAmountWei)} base units` : '';
      return `Pay MPP route ${String(input.route)} for ${amount}${chain} to ${url}${from}${cap}${key}`;
    }
    case 'createCardCheckout':
      return `Create a card checkout link for ${
        input.productKey ? `product ${String(input.productKey)}` : `amount ${String(input.amount)}`
      } at ${url}${key}`;
    default:
      return `${name} for ${url}`;
  }
}

/** All seven public PayKit operations. The CLI journal survives restarts. */
export async function runPaykitCli(argv: string[]): Promise<number> {
  loadEnvFromCwd();
  const program = new Command().name('agentkit-paykit').description('GOAT Flow public PayKit payments and recovery');
  program
    .exitOverride()
    .option('--json', 'Print machine-readable results')
    .option('--auto-confirm', 'Approve the selected write operation without a prompt')
    .option('--reveal-secrets', 'Print checkout/session handles and MPP receipts (private by default)')
    .option(
      '--state-dir <directory>',
      'Durable private payment journal',
      process.env.PAYKIT_STATE_DIR?.trim() || join(homedir(), '.agentkit', 'paykit'),
    )
    .option(
      '--emergency-dir <directory>',
      'Existing private emergency parent, separate from --state-dir (prefer another filesystem)',
      process.env.PAYKIT_EMERGENCY_DIR?.trim() || undefined,
    )
    .option('--rpc-url <url>', 'EVM RPC URL (or PAYKIT_RPC_URL / PAYKIT_RPC_<chainId>)')
    .option(
      '--timeout-ms <ms>',
      'Action timeout (pending submissions are drained before exit)',
      timeoutMilliseconds,
      120_000,
    );
  let exitCode = 0;
  const format = (): OutputFormat => (program.opts().json ? 'json' : 'human');

  const execute = async (
    name: keyof typeof paykitActionDefinitions,
    input: Record<string, unknown>,
    chainId?: number,
  ) => {
    const opts = program.opts();
    // Validate the complete action input before loading a key or making requests.
    const definition = paykitActionDefinitions[name];
    const parsed = definition.zodInputSchema!.safeParse(input);
    if (!parsed.success) {
      emit(
        {
          ok: false,
          errorCode: ErrorCodes.INVALID_INPUT,
          error: formatZodIssues(parsed.error.issues).join('; '),
        },
        format(),
      );
      exitCode = 1;
      return;
    }
    const needsWallet = ['pay', 'payProduct', 'payMpp', 'resumeMpp'].includes(name);
    const recoveryStore = new FilePaymentRecoveryStore(opts.stateDir);
    const mayNeedEmergencyStorage = needsWallet || name === 'createCardCheckout';
    if (mayNeedEmergencyStorage && opts.emergencyDir !== undefined) {
      const emergency = await validateEmergencyDirectory(opts.emergencyDir, opts.stateDir);
      for (const warning of emergency.warnings) process.stderr.write(`Warning: ${warning}\n`);
    }
    let signer: Wallet | undefined;
    let wallet: EvmWalletProvider | undefined;
    let provider: JsonRpcProvider | undefined;
    let rpcUrl: string | undefined;
    if (needsWallet) {
      const key = process.env.PAYKIT_PRIVATE_KEY || process.env.GOAT_PRIVATE_KEY;
      if (!key)
        throw new AgentkitRuntimeError(ErrorCodes.INVALID_INPUT, 'Set PAYKIT_PRIVATE_KEY (or GOAT_PRIVATE_KEY)');
      try {
        signer = new Wallet(key);
      } catch {
        throw new AgentkitRuntimeError(ErrorCodes.INVALID_INPUT, 'Invalid wallet key configuration');
      }
      if (name !== 'resumeMpp') {
        const rpc = opts.rpcUrl || process.env[`PAYKIT_RPC_${chainId}`] || process.env.PAYKIT_RPC_URL;
        if (!rpc)
          throw new AgentkitRuntimeError(
            ErrorCodes.INVALID_INPUT,
            'Set --rpc-url, PAYKIT_RPC_URL, or PAYKIT_RPC_<chainId>',
          );
        let parsedRpc: URL;
        try {
          parsedRpc = new URL(rpc);
        } catch {
          throw new AgentkitRuntimeError(ErrorCodes.INVALID_INPUT, 'Invalid RPC URL');
        }
        if (!['http:', 'https:'].includes(parsedRpc.protocol))
          throw new AgentkitRuntimeError(ErrorCodes.INVALID_INPUT, 'RPC URL must use HTTP or HTTPS');
        rpcUrl = rpc;
      }
    }
    // Execute against the manifest the operator approved. A price changed after
    // approval then fails the payment's own terms checks before anything is signed.
    const manifestUrl = paymentTarget(String(parsed.data.url)).manifestUrl;
    let approvedManifest: string | undefined;
    const merchantFetch: typeof fetch = async (request, init) => {
      if ((request instanceof Request ? request.url : String(request)) !== manifestUrl) return fetch(request, init);
      if (approvedManifest !== undefined)
        return new Response(approvedManifest, { headers: { 'content-type': 'application/json' } });
      const response = await fetch(request, init);
      if (response.ok) approvedManifest = await response.clone().text();
      return response;
    };
    if (definition.requiresConfirmation) {
      let summary = `${name} for ${input.url}`;
      if (!opts.autoConfirm) {
        const payer = signer && {
          address: signer.address,
          source: process.env.PAYKIT_PRIVATE_KEY ? 'PAYKIT_PRIVATE_KEY' : 'GOAT_PRIVATE_KEY',
        };
        const quote = () =>
          new PaykitService({ fetchImpl: merchantFetch }).inspect(String(parsed.data.url), {
            traceId: 'cli-confirmation',
            network: chainId ? `eip155:${chainId}` : 'paykit',
            now: Date.now(),
          });
        // A completed or in-flight intent replays or reports recovery without a
        // new payment, so it must not depend on a live merchant quote.
        const key = (parsed.data as { idempotencyKey?: unknown }).idempotencyKey;
        const journaled = typeof key === 'string' ? await journaledIntent(recoveryStore, key) : undefined;
        const existing = `${name} for ${String(parsed.data.url)}: return or recover the journaled`;
        try {
          summary =
            journaled === 'unverified'
              ? `${existing} intent ${String(key)}, which needs reconciliation; no new payment is sent`
              : journaled && !canPreparePayment(journaled)
                ? `${existing} ${journaled.rail} intent ${String(key)} (${journaled.phase}); no new payment is sent`
                : await confirmationSummary(name, parsed.data, chainId, payer, quote);
        } catch {
          emit(
            {
              ok: false,
              errorCode: ErrorCodes.ADAPTER_REQUEST_FAILED,
              error: 'Cannot load the merchant quote for confirmation; no payment was sent',
            },
            format(),
          );
          exitCode = 10;
          return;
        }
      }
      if (!(await confirm(summary, { autoConfirm: opts.autoConfirm }))) {
        emit({ ok: false, errorCode: ErrorCodes.POLICY_BLOCKED, error: 'Payment declined' }, format());
        exitCode = 4;
        return;
      }
    }
    // Configuration is validated before approval; create the RPC provider only
    // after approval so declining cannot leave network detection running.
    if (signer && rpcUrl) {
      provider = new JsonRpcProvider(rpcUrl);
      signer = signer.connect(provider);
      wallet = new EvmWalletProvider(signer, provider, `eip155:${chainId}`);
    }
    const service = new PaykitService({
      wallet,
      mppSigner: signer,
      recoveryStore,
      allowedChainIds: chainId ? [chainId] : undefined,
      fetchImpl: merchantFetch,
    });
    const action = createPaykitActions(service).find((a) => a.name === definition.name)!;
    let settlement = Promise.resolve<ActionRecovery | undefined>(undefined);
    const controller = new AbortController();
    let interrupted = false;
    const interrupt = () => {
      if (interrupted) {
        process.stderr.write('Forced exit. Inspect the payment journal and recover this intent before retrying.\n');
        process.exit(130);
      }
      interrupted = true;
      process.stderr.write(
        'Cancellation requested; waiting for any pending submission checkpoint. Press Ctrl-C again to exit immediately and recover from the journal.\n',
      );
      controller.abort();
    };
    process.on('SIGINT', interrupt);
    try {
      const run = await runAction(action, {
        network: chainId ? `eip155:${chainId}` : 'paykit',
        input, // Runtime parses the raw input; do not apply transforms to parsed output again.
        format: format(),
        signal: controller.signal,
        executionOptions: { confirmed: !!definition.requiresConfirmation, timeoutMs: opts.timeoutMs },
      });
      // A runtime timeout cancels new work but cannot retract an accepted RPC
      // submission. Keep the provider/process alive until its hash is journaled.
      settlement = run.result.settled ?? Promise.resolve(run.result.recovery);
      const latestRecovery = await settlement;
      if (!run.result.ok && latestRecovery) run.result.recovery = latestRecovery;
      const completed =
        !run.result.ok &&
        (run.result.errorCode === ErrorCodes.TIMEOUT || run.result.errorCode === ErrorCodes.ABORTED) &&
        latestRecovery?.phase === 'complete' &&
        latestRecovery.result !== undefined &&
        !latestRecovery.persistenceError
          ? await recoveryStore.get(latestRecovery.operationId).catch(() => undefined)
          : undefined;
      if (
        completed?.phase === 'complete' &&
        completed.result !== undefined &&
        completed.fingerprint === latestRecovery?.fingerprint
      ) {
        // Settlement may include a successful completion checkpoint after the
        // caller's deadline. Report that known outcome with normal redaction.
        run.result.ok = true;
        run.result.output = replayResult(completed);
        delete run.result.error;
        delete run.result.errorCode;
        delete run.result.recovery;
        run.exitCode = 0;
        process.stderr.write('Payment operation completed while waiting for cancellation cleanup.\n');
      }
      if (run.result.recovery) {
        run.result.recovery = await paykitRecoveryOutput(
          run.result.recovery,
          opts.revealSecrets,
          opts.emergencyDir,
          opts.stateDir,
        );
        if (run.result.recovery.persistenceError)
          process.stderr.write(
            [run.result.recovery.persistenceError, run.result.recovery.recoveryHint].filter(Boolean).join('. ') + '\n',
          );
      }
      reportResult(run, format(), { revealAll: opts.revealSecrets });
      if (!run.result.ok && format() === 'human' && run.result.recovery)
        emit({ recovery: run.result.recovery }, format());
      exitCode = run.result.errorCode === ErrorCodes.RECOVERY_REQUIRED ? 10 : run.exitCode;
    } finally {
      controller.abort();
      await settlement;
      process.removeListener('SIGINT', interrupt);
      provider?.destroy();
    }
  };

  program
    .command('inspect <url>')
    .description('Inspect merchant tokens, products and payment rails')
    .action((url: string) => execute('inspect', { url }));
  const paymentOptions = (command: Command) =>
    command
      .requiredOption('--chain-id <id>', 'EVM payment chain', positiveInteger)
      .option('--token <symbol>', 'Token symbol (prefer an explicit contract if ambiguous)')
      .option('--token-contract <address>', 'ERC-20 contract')
      .requiredOption('--idempotency-key <key>', 'Stable identifier for this payment intent')
      .option('--poll-timeout-ms <ms>', 'Status polling deadline', positiveInteger)
      .option('--poll-interval-ms <ms>', 'Status polling interval', positiveInteger);
  const paymentInput = (url: string, o: Record<string, unknown>) => ({
    url,
    chainId: o.chainId,
    tokenSymbol: o.token,
    tokenContract: o.tokenContract,
    idempotencyKey: o.idempotencyKey,
    pollTimeoutMs: o.pollTimeoutMs,
    pollIntervalMs: o.pollIntervalMs,
  });
  paymentOptions(program.command('pay-x402 <url>').description('Pay a custom ERC-20 amount'))
    .requiredOption('--amount <decimal>', 'Human decimal amount')
    .option('--memo <text>', 'Payment memo')
    .action((url, o) => execute('pay', { ...paymentInput(url, o), amount: o.amount, memo: o.memo }, o.chainId));
  paymentOptions(program.command('pay-product <url>').description('Pay a merchant product at its quoted price'))
    .requiredOption('--product <key>', 'Merchant product key')
    .action((url, o) => execute('payProduct', { ...paymentInput(url, o), productKey: o.product }, o.chainId));
  program
    .command('status <url>')
    .description('Read a session; never sends a transfer')
    .option('--session-id <id>', 'Public session handle')
    .option('--operation-id <key>', 'Original payment idempotency key in the journal')
    .option('--expected-fingerprint <hash>', 'Match the original payment terms fingerprint')
    .action((url, o) =>
      execute('sessionStatus', {
        url,
        sessionId: o.sessionId,
        operationId: o.operationId,
        expectedFingerprint: o.expectedFingerprint,
      }),
    );
  program
    .command('pay-mpp <url>')
    .description('Pay a GOAT Flow MPP route and obtain its receipt')
    .requiredOption('--route <route>', 'Canonical route from inspect, e.g. GET:api:data')
    .requiredOption('--chain-id <id>', 'Expected route chain', positiveInteger)
    .requiredOption('--idempotency-key <key>', 'Stable identifier for this payment intent')
    .option('--max-amount-wei <wei>', 'Maximum base-unit amount (defaults to the manifest quote)')
    .option('--max-verify-attempts <count>', 'Verification attempts, 1–16', positiveInteger)
    .action((url, o) =>
      execute(
        'payMpp',
        {
          url,
          route: o.route,
          idempotencyKey: o.idempotencyKey,
          maxAmountWei: o.maxAmountWei,
          maxVerifyAttempts: o.maxVerifyAttempts,
        },
        o.chainId,
      ),
    );
  program
    .command('resume-mpp <url>')
    .description('Verify a journaled MPP transfer again; never pays again')
    .requiredOption('--operation-id <key>', 'Original payment idempotency key')
    .option('--expected-fingerprint <hash>', 'Original recovery fingerprint; reject a replaced journal intent')
    .option('--max-verify-attempts <count>', 'Verification attempts, 1–16', positiveInteger)
    .action((url, o) =>
      execute('resumeMpp', {
        url,
        operationId: o.operationId,
        expectedFingerprint: o.expectedFingerprint,
        maxVerifyAttempts: o.maxVerifyAttempts,
      }),
    );
  program
    .command('create-card-checkout <url>')
    .description('Create a hosted link for a human to complete card payment')
    .option('--product <key>', 'Merchant product key')
    .option('--amount <decimal>', 'Custom decimal amount')
    .option('--memo <text>', 'Custom payment memo')
    .requiredOption('--idempotency-key <key>', 'Local creation guard; the server does not guarantee replay')
    .action((url, o) =>
      execute('createCardCheckout', {
        url,
        productKey: o.product,
        amount: o.amount,
        memo: o.memo,
        idempotencyKey: o.idempotencyKey,
      }),
    );

  try {
    await program.parseAsync(argv);
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    const inputError =
      error instanceof ConfirmationRequiredError ||
      (error instanceof AgentkitRuntimeError && error.code === ErrorCodes.INVALID_INPUT);
    emit(
      {
        ok: false,
        errorCode: inputError ? ErrorCodes.INVALID_INPUT : ErrorCodes.ADAPTER_REQUEST_FAILED,
        error: inputError ? error.message : 'PayKit command failed; inspect the payment journal before retrying',
      },
      format(),
    );
    return inputError ? 1 : 10;
  }
}
