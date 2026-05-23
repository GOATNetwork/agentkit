/**
 * GNS cross-chain register example via x402.
 *
 * Sequence:
 *   commit (GOAT)
 *   → x402.createOrder
 *   → x402.submitSignature  (signed by a GOAT-bound EvmPayerWalletAdapter)
 *   → x402.payOrder         (executed by a source-chain-bound EvmPayerWalletAdapter + WalletProvider)
 *   → poll x402.getOrderStatus until PAYMENT_CONFIRMED
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
import {
  ActionProvider,
  ExecutionRuntime,
  PolicyEngine,
} from '../../index';
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

  // 1. Commit on GOAT.
  console.log('▶ commit');
  const commit = await runtime.run(
    provider.get('goat.gns.commit'),
    baseCtx,
    {
      name,
      owner,
      years: 1,
      paymentTokenAddress: contracts.publicResolver, // placeholder when DEMO_MOCK; real run uses GOAT-side token
      paymentTokenSymbol: settlementSymbol,
      amountWei: '3000000000000000000',
    },
    { confirmed: true },
  );
  console.log('  ↳', commit.output);
  if (!commit.ok || !commit.output) return;

  // 2. Create x402 order.
  console.log('▶ x402.createOrder');
  const order = await runtime.run(
    provider.get('goat.gns.x402.createOrder'),
    baseCtx,
    {
      name,
      owner,
      payer: owner,
      years: 1,
      settlementChainId,
      settlementTokenSymbol: settlementSymbol,
      settlementTokenContract: settlementTokenContract ?? ('0x' + '0'.repeat(40)) as `0x${string}`,
      secret: commit.output.secret,
      commitment: commit.output.commitment,
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

  // 4. Pay on source chain.
  console.log('▶ x402.payOrder (source-chain ERC-20 transfer)');
  const sourceCtx = { ...baseCtx, network: 'source' };
  const paid = await runtime.run(
    provider.get('goat.gns.x402.payOrder'),
    sourceCtx,
    { orderId: order.output.orderId },
    { confirmed: true },
  );
  console.log('  ↳', paid.output);
  if (!paid.ok) return;

  // 5. Poll status.
  console.log('▶ x402.getOrderStatus (poll every 10s, max 5 min)');
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const status = await runtime.run(provider.get('goat.gns.x402.getOrderStatus'), baseCtx, {
      orderId: order.output.orderId,
    });
    console.log('  ↳', status.output?.status);
    if (status.output?.status === 'PAYMENT_CONFIRMED' || status.output?.status === 'INVOICED') break;
    if (status.output?.status === 'FAILED' || status.output?.status === 'EXPIRED') break;
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
