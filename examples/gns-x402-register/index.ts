/**
 * GNS cross-chain register example via x402.
 *
 * Sequence:
 *   commit (GOAT)
 *   → x402.createOrder
 *   → x402.submitSignature  (signed by a GOAT-bound EvmPayerWalletAdapter)
 *   → x402.payOrder         (executed by a source-chain-bound EvmPayerWalletAdapter + WalletProvider)
 *   → poll x402.getOrderStatus until INVOICED (true success for DELEGATE
 *     callback orders — PAYMENT_CONFIRMED only means the source-chain
 *     transfer landed; INVOICED means the adaptor callback executed on GOAT
 *     and the .goat name was actually registered) or terminal failure
 *     (FAILED / EXPIRED / CANCELLED).
 *
 * Wallet requirement: this entire flow needs a real signer on the GOAT
 * adaptor chain (mainnet 2345 / testnet3 48816) AND a real signer + RPC on
 * the source chain (e.g. Base 8453). NoopWalletProvider returns mock
 * signatures that the upstream gateway will reject. See plan §D matrix.
 *
 * Two-adapter pattern (Codex R3 #A):
 *   const goatPayerAdapter   = new EvmPayerWalletAdapter(goatSigner);   // submitSignature
 *   const sourcePayerAdapter = new EvmPayerWalletAdapter(sourceSigner); // payOrder
 *
 * Each adapter holds a single `Signer`; sharing one would either sign on
 * the wrong chain or send the ERC-20 transfer on the wrong chain.
 */
import { JsonRpcProvider, Wallet } from 'ethers';
import { ActionProvider, ExecutionRuntime, PolicyEngine } from '../../index';
import { EvmWalletProvider } from '../../core/wallet/evm-wallet-provider';
import { NoopWalletProvider } from '../../core/wallet/noop-wallet-provider';
import { EvmPayerWalletAdapter } from '../../plugins/x402/adapters/evm-payer-wallet';
import {
  HttpGnsApiAdapter,
  commitAction,
  getGnsContracts,
  x402CreateOrderAction,
  x402GetOrderStatusAction,
  x402PayOrderAction,
  x402SubmitSignatureAction,
} from '../../plugins/gns/index';
import { estimatePriceAction } from '../../plugins/gns/actions/estimate-price';
import { waitForCommitmentAction } from '../../plugins/gns/actions/wait-for-commitment';
import { GNS_PAYMENT_TOKENS, resolveGnsPaymentToken } from '../../plugins/gns/constants';
import { goatNetworks } from '../../networks/goat/config';

async function main() {
  const networkKey: 'goat-mainnet' | 'goat-testnet' =
    (process.env.GNS_NETWORK as 'goat-mainnet' | 'goat-testnet' | undefined) ?? 'goat-testnet';
  const contracts = getGnsContracts(networkKey);
  const api = new HttpGnsApiAdapter({ network: networkKey });

  const demoMock = process.env.DEMO_MOCK === 'true';
  const goatPrivateKey = process.env.GOAT_PRIVATE_KEY;
  const sourcePrivateKey = process.env.PAYMENT_CHAIN_PRIVATE_KEY ?? goatPrivateKey;
  const sourceRpc = process.env.PAYMENT_CHAIN_RPC_URL;
  const settlementChainId = Number(process.env.GNS_X402_SETTLEMENT_CHAIN_ID ?? '8453');
  const settlementSymbol = process.env.GNS_X402_SETTLEMENT_SYMBOL ?? 'USDC';
  const settlementTokenContract = process.env.GNS_X402_SETTLEMENT_TOKEN_CONTRACT as `0x${string}` | undefined;

  if (!demoMock && (!goatPrivateKey || !sourcePrivateKey || !sourceRpc || !settlementTokenContract)) {
    throw new Error(
      'This example requires GOAT_PRIVATE_KEY, PAYMENT_CHAIN_PRIVATE_KEY, PAYMENT_CHAIN_RPC_URL, GNS_X402_SETTLEMENT_TOKEN_CONTRACT. Pass DEMO_MOCK=true to dry-run shape only.',
    );
  }

  // GOAT-side wallet for the commit + the adaptor-chain typed-data signature.
  const goatRpc = goatNetworks[networkKey].rpcUrl;
  const goatWallet = demoMock
    ? new NoopWalletProvider('0x0000000000000000000000000000000000000001', {
        networkName: networkKey,
        chainId: contracts.chainId,
      })
    : new EvmWalletProvider(
        new Wallet(goatPrivateKey!, new JsonRpcProvider(goatRpc)),
        new JsonRpcProvider(goatRpc),
        networkKey,
      );

  // Source-chain wallet + payer adapter (the chain the user is paying from).
  const sourceWallet = demoMock
    ? new NoopWalletProvider('0x0000000000000000000000000000000000000001', {
        networkName: 'base-mainnet',
        chainId: settlementChainId,
      })
    : new EvmWalletProvider(
        new Wallet(sourcePrivateKey!, new JsonRpcProvider(sourceRpc!)),
        new JsonRpcProvider(sourceRpc!),
        'source',
      );

  // Two-instance pattern: separate adapter bound to each chain's Signer.
  const goatPayerAdapter = demoMock
    ? null
    : new EvmPayerWalletAdapter(new Wallet(goatPrivateKey!, new JsonRpcProvider(goatRpc)));
  const sourcePayerAdapter = demoMock
    ? null
    : new EvmPayerWalletAdapter(new Wallet(sourcePrivateKey!, new JsonRpcProvider(sourceRpc!)));

  // Wire up actions. submitSignature uses the GOAT payer adapter; payOrder
  // uses the source-chain payer adapter.
  const provider = new ActionProvider();
  provider.register(commitAction(contracts, goatWallet));
  provider.register(waitForCommitmentAction(contracts, goatWallet));
  provider.register(estimatePriceAction(api));
  provider.register(x402CreateOrderAction(api));
  if (goatPayerAdapter) provider.register(x402SubmitSignatureAction(api, goatPayerAdapter));
  if (sourcePayerAdapter) provider.register(x402PayOrderAction(api, sourcePayerAdapter, sourceWallet));
  provider.register(x402GetOrderStatusAction(api));

  const policy = new PolicyEngine({
    allowedNetworks: [networkKey, 'source'],
    maxRiskWithoutConfirm: 'low',
    writeEnabled: true,
  });
  const runtime = new ExecutionRuntime(policy, { maxRetries: 0, retryDelayMs: 200 });
  const baseCtx = { traceId: `demo_${Date.now()}`, network: networkKey, now: Date.now() };

  const name = process.env.GNS_DEMO_NAME ?? `agent-${Date.now()}`;
  const owner = await goatWallet.getAddress();
  // F4 fix: the address that actually broadcasts the source-chain ERC-20
  // transfer in payOrder is `sourceWallet.getAddress()` (could differ from
  // `owner` when PAYMENT_CHAIN_PRIVATE_KEY ≠ GOAT_PRIVATE_KEY). Pass it
  // as `createOrder.payer` so the order is recorded with the correct
  // payer up-front; otherwise payOrder's 3-way binding would catch the
  // mismatch only after GOAT-side gas is already burned.
  const sourcePayerAddr = await sourceWallet.getAddress();

  // 0. Resolve GOAT-side payment token by symbol and quote the priced
  // amount. The commit hash binds (GOAT-side paymentToken, maxPaymentAmount)
  // — the backend re-derives the same tuple in payments.service.ts:305-308
  // / names.service.ts:341-344. Using publicResolver (a vestigial
  // placeholder) or the source-chain token here would make the on-chain
  // commit hash diverge from the backend's recomputation and break
  // x402.createOrder with `Commitment does not match registration payload`.
  const goatPaymentToken = resolveGnsPaymentToken(networkKey, settlementSymbol);
  if (!goatPaymentToken) {
    const known = (GNS_PAYMENT_TOKENS[networkKey] ?? []).map((t) => t.symbol).join(', ') || 'none';
    throw new Error(
      `Unsupported GNS_X402_SETTLEMENT_SYMBOL "${settlementSymbol}" on ${networkKey}; the GNS commit binds a GOAT-side token (known: ${known}).`,
    );
  }

  console.log('▶ estimatePrice (GOAT-side, sets commit-bound amount)');
  const quote = await runtime.run(
    provider.get('goat.gns.estimatePrice'),
    baseCtx,
    { name, years: 1, tokenContract: goatPaymentToken.address },
    { confirmed: true },
  );
  console.log('  ↳', quote.output);
  if (!quote.ok || !quote.output) return;
  const goatAmountWei = (quote.output as { totalWei: string }).totalWei;

  // 1. Commit on GOAT.
  console.log('▶ commit');
  const commit = await runtime.run(
    provider.get('goat.gns.commit'),
    baseCtx,
    {
      name,
      owner,
      years: 1,
      paymentTokenAddress: goatPaymentToken.address,
      paymentTokenSymbol: goatPaymentToken.symbol,
      amountWei: goatAmountWei,
    },
    { confirmed: true },
  );
  console.log('  ↳', commit.output);
  if (!commit.ok || !commit.output) return;

  // 1b. Wait for the reveal window. The backend rejects createOrder with
  // `Commitment is not ready to reveal yet` if `block.timestamp < revealAt`
  // (goat-ens backend names.service.ts:300-304, called from
  // payments.service.ts:374). Skip in DEMO_MOCK since the NoopWalletProvider
  // can't read the chain — the order will fail anyway under mock signers.
  if (!demoMock) {
    console.log('▶ waitForCommitment (poll until block.timestamp ≥ revealAt)');
    const waitDeadline = Date.now() + 180_000;
    for (;;) {
      const wait = await runtime.run(
        provider.get('goat.gns.waitForCommitment'),
        baseCtx,
        { commitment: commit.output.commitment },
        { confirmed: true },
      );
      console.log('  ↳', wait.output);
      if (!wait.ok || !wait.output) return;
      const out = wait.output as { isReady: boolean; isExpired: boolean };
      if (out.isExpired) {
        console.error('commitment expired before reveal window opened; re-run');
        return;
      }
      if (out.isReady) break;
      if (Date.now() >= waitDeadline) {
        console.error('reveal window did not open within 180s');
        return;
      }
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }

  // 2. Create x402 order. We pin commitMaxAmountWei to the same value
  // baked into the commit hash so the backend's strict-equality check at
  // payments.service.ts:343 / 346-353 passes. We also forward the CANONICAL
  // symbol from goatPaymentToken (not the raw GNS_X402_SETTLEMENT_SYMBOL)
  // so the backend's requestedSymbol === canonicalSymbol check at
  // payments.service.ts:266-272 passes for callers passing aliases like
  // `TUSDT` for `USDT`.
  console.log('▶ x402.createOrder');
  const order = await runtime.run(
    provider.get('goat.gns.x402.createOrder'),
    baseCtx,
    {
      name,
      owner,
      // F4 fix: source-chain payer, not GOAT-side owner (see sourcePayerAddr above)
      payer: sourcePayerAddr,
      years: 1,
      settlementChainId,
      settlementTokenSymbol: goatPaymentToken.symbol,
      settlementTokenContract: settlementTokenContract ?? (('0x' + '0'.repeat(40)) as `0x${string}`),
      secret: commit.output.secret,
      commitment: commit.output.commitment,
      commitMaxAmountWei: goatAmountWei,
    },
    { confirmed: true },
  );
  console.log('  ↳', { orderId: order.output?.orderId, flow: order.output?.flow });
  if (!order.ok || !order.output) return;

  // 3. Submit signature (GOAT adaptor chain).
  console.log('▶ x402.submitSignature (signed by GOAT-bound payer)');
  const signed = await runtime.run(
    provider.get('goat.gns.x402.submitSignature'),
    baseCtx,
    {
      orderId: order.output.orderId,
      calldataSignRequest: order.output.calldataSignRequest,
    },
    { confirmed: true },
  );
  console.log('  ↳', signed.output);
  if (!signed.ok) return;

  // 4. Pay on source chain. payOrder takes the createOrder response's
  // payment routing fields as inputs (payToAddress / tokenContract /
  // amountWei / expiresAt / payChainId). The status endpoint is a
  // lifecycle-only projection that does NOT carry these fields, so the
  // SDK threads them through from createOrder instead of re-fetching.
  console.log('▶ x402.payOrder (source-chain ERC-20 transfer)');
  const sourceCtx = { ...baseCtx, network: 'source' };
  const paid = await runtime.run(
    provider.get('goat.gns.x402.payOrder'),
    sourceCtx,
    {
      orderId: order.output.orderId,
      payChainId: order.output.payChainId,
      tokenContract: order.output.tokenContract,
      payToAddress: order.output.payToAddress,
      amountWei: order.output.amountWei,
      expiresAt: order.output.expiresAt,
      // Threaded so payOrder's defense-in-depth gate can cross-check
      // input.payToAddress against the merchant's signed authorization
      // (Issue #3 Round 2 — Codex P1).
      calldataSignRequest: order.output.calldataSignRequest,
    },
    { confirmed: true },
  );
  console.log('  ↳', paid.output);
  if (!paid.ok) return;

  // 5. Poll status until INVOICED (true success for DELEGATE/callback orders —
  // PAYMENT_CONFIRMED only means the source-chain transfer landed; INVOICED
  // means the adaptor callback executed on GOAT and the name is registered).
  // Terminal failure states: FAILED, EXPIRED, CANCELLED.
  console.log('▶ x402.getOrderStatus (poll every 10s, max 5 min)');
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const status = await runtime.run(provider.get('goat.gns.x402.getOrderStatus'), baseCtx, {
      orderId: order.output.orderId,
    });
    const s = status.output?.status;
    console.log('  ↳', s);
    // Stop only on the true terminal states. PAYMENT_CONFIRMED is
    // intermediate for DELEGATE/callback orders.
    if (s === 'INVOICED') break;
    if (s === 'FAILED' || s === 'EXPIRED' || s === 'CANCELLED') break;
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
