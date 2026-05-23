/**
 * GNS direct-register example (testnet3).
 *
 * Sequence:
 *   checkAvailability → estimatePrice → commit → poll waitForCommitment
 *   → register → setProfileRecords → setPrimaryName
 *
 * Wallet requirement: this example performs on-chain writes. The
 * `NoopWalletProvider` returns mock tx hashes that look successful but never
 * touch a chain. Set `GOAT_PRIVATE_KEY` (and optionally `DEMO_MOCK=true` to
 * dry-run with a Noop wallet for shape inspection only).
 */
import { JsonRpcProvider, Wallet } from 'ethers';
import {
  ActionProvider,
  ExecutionRuntime,
  PolicyEngine,
} from '../../index';
import { EvmWalletProvider } from '../../core/wallet/evm-wallet-provider';
import { NoopWalletProvider } from '../../core/wallet/noop-wallet-provider';
import {
  HttpGnsApiAdapter,
  checkAvailabilityAction,
  commitAction,
  estimatePriceAction,
  registerAction,
  setPrimaryNameAction,
  setProfileRecordsAction,
  waitForCommitmentAction,
  getGnsContracts,
  MIN_COMMITMENT_AGE_SEC,
} from '../../plugins/gns/index';
import { goatNetworks } from '../../networks/goat/config';

async function main() {
  const networkKey: 'goat-mainnet' | 'goat-testnet' =
    (process.env.GNS_NETWORK as 'goat-mainnet' | 'goat-testnet' | undefined) ?? 'goat-testnet';
  const contracts = getGnsContracts(networkKey);
  const api = new HttpGnsApiAdapter({ network: networkKey });

  const demoMock = process.env.DEMO_MOCK === 'true';
  const privateKey = process.env.GOAT_PRIVATE_KEY;
  if (!demoMock && !privateKey) {
    throw new Error(
      'This example requires a real wallet; set GOAT_PRIVATE_KEY in .env or pass DEMO_MOCK=true to dry-run.',
    );
  }

  const wallet = demoMock || !privateKey
    ? new NoopWalletProvider('0x0000000000000000000000000000000000000001', {
        networkName: networkKey,
        chainId: contracts.chainId,
      })
    : new EvmWalletProvider(
        new Wallet(privateKey, new JsonRpcProvider(goatNetworks[networkKey].rpcUrl)),
        new JsonRpcProvider(goatNetworks[networkKey].rpcUrl),
        networkKey,
      );

  const provider = new ActionProvider();
  provider.register(checkAvailabilityAction(api));
  provider.register(estimatePriceAction(api));
  provider.register(commitAction(contracts, wallet));
  provider.register(waitForCommitmentAction(contracts, wallet));
  provider.register(registerAction(contracts, wallet));
  provider.register(setProfileRecordsAction(contracts, wallet));
  provider.register(setPrimaryNameAction(contracts, wallet));

  const policy = new PolicyEngine({
    allowedNetworks: [networkKey],
    maxRiskWithoutConfirm: 'low',
    writeEnabled: true,
  });
  const runtime = new ExecutionRuntime(policy, { maxRetries: 0, retryDelayMs: 200 });

  const ctx = { traceId: `demo_${Date.now()}`, network: networkKey, now: Date.now() };
  const name = process.env.GNS_DEMO_NAME ?? `agent-${Date.now()}`;

  console.log(`▶ checkAvailability ${name}.goat`);
  const avail = await runtime.run(provider.get('goat.gns.checkAvailability'), ctx, { name });
  console.log('  ↳', avail.output);
  if (!avail.ok || !avail.output?.available) {
    console.log('Name not available — aborting.');
    return;
  }

  console.log('▶ estimatePrice');
  const quote = await runtime.run(provider.get('goat.gns.estimatePrice'), ctx, {
    name,
    years: 1,
    tokenContract: process.env.GNS_PAYMENT_TOKEN_CONTRACT as `0x${string}` | undefined,
  });
  console.log('  ↳', quote.output);
  if (!quote.ok || !quote.output) return;

  const owner = await wallet.getAddress();
  console.log('▶ commit');
  const commit = await runtime.run(
    provider.get('goat.gns.commit'),
    ctx,
    {
      name,
      owner,
      years: 1,
      paymentTokenAddress: (process.env.GNS_PAYMENT_TOKEN_CONTRACT ?? quote.output.currency) as `0x${string}`,
      paymentTokenSymbol: quote.output.currency,
      amountWei: quote.output.totalWei,
    },
    { confirmed: true },
  );
  console.log('  ↳', { commitment: commit.output?.commitment, txHash: commit.output?.txHash });
  if (!commit.ok || !commit.output) return;

  console.log(`▶ waitForCommitment (poll every 5s, max ~${MIN_COMMITMENT_AGE_SEC + 300}s)`);
  const deadline = Date.now() + (MIN_COMMITMENT_AGE_SEC + 300) * 1000;
  // In DEMO_MOCK mode the noop wallet has no real block timestamp; skip polling.
  if (demoMock) {
    console.log('  ↳ (DEMO_MOCK) skipping on-chain readiness polling');
  } else {
    while (Date.now() < deadline) {
      const w = await runtime.run(provider.get('goat.gns.waitForCommitment'), ctx, {
        commitment: commit.output.commitment,
      });
      console.log('  ↳', { isReady: w.output?.isReady, isExpired: w.output?.isExpired });
      if (w.output?.isReady) break;
      if (w.output?.isExpired) {
        console.log('Commitment expired — re-run the script to start over.');
        return;
      }
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }

  console.log('▶ register');
  const reg = await runtime.run(
    provider.get('goat.gns.register'),
    ctx,
    {
      name: commit.output.registration.label + '.goat',
      commitHash: commit.output.commitment,
      paymentTokenAddress: commit.output.paymentToken.address,
      paymentTokenSymbol: commit.output.paymentToken.symbol,
      amountWei: commit.output.amountWei,
      duration: commit.output.registration.duration,
      years: commit.output.years,
      secret: commit.output.secret,
      owner: commit.output.registration.owner,
      resolverData: commit.output.registration.data,
      reverseRecord: commit.output.registration.reverseRecord,
      referrer: commit.output.registration.referrer,
    },
    { confirmed: true },
  );
  console.log('  ↳', reg.output);

  if (!reg.ok) return;

  console.log('▶ setProfileRecords (description + url)');
  const records = await runtime.run(
    provider.get('goat.gns.setProfileRecords'),
    ctx,
    {
      name,
      records: [
        { key: 'description', value: 'GOAT-agent prototype' },
        { key: 'url', value: 'https://example.com' },
      ],
    },
    { confirmed: true },
  );
  console.log('  ↳', records.output);

  console.log('▶ setPrimaryName');
  const primary = await runtime.run(
    provider.get('goat.gns.setPrimaryName'),
    ctx,
    { name },
    { confirmed: true },
  );
  console.log('  ↳', primary.output);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
