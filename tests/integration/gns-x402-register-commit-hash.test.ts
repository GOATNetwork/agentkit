/**
 * Regression — GNS x402-register commit-hash divergence.
 *
 * The `agentkit-gns x402-register` CLI used to bake `(publicResolver, 0)`
 * into the on-chain commit hash while the GNS backend re-derives the hash
 * with the GOAT-side stablecoin address + a real priced amount (see
 * goat-ens/backend payments.service.ts:305-308 and names.service.ts:341-344).
 * The two hashes can never agree, so `createOrder` always rejects with
 * `Commitment does not match registration payload`.
 *
 * The fix (cli-gns.ts):
 *   1. Resolve the GOAT-side payment token by symbol via
 *      `resolveGnsPaymentToken(networkKey, payToken)`.
 *   2. Quote the GOAT-side priced amount via `estimatePriceAction`.
 *   3. Pass `(goatToken.address, quoted.totalWei)` into commit.
 *   4. Pin `commitMaxAmountWei` on createOrder so the backend's
 *      strict-equality check (payments.service.ts:343, 346-353) passes.
 *
 * This test drives those same three actions with mocks and asserts the
 * payment tuple handed to the controller's on-chain `makeCommitment` is
 * the post-fix shape, not the bug shape.
 */
import { describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { ActionProvider } from '../../providers/action-provider';
import { PolicyEngine } from '../../core/policy/policy-engine';
import { ExecutionRuntime } from '../../core/runtime/execution-runtime';
import { commitAction } from '../../plugins/gns/actions/commit';
import { estimatePriceAction } from '../../plugins/gns/actions/estimate-price';
import { GNS_PAYMENT_TOKENS, resolveGnsPaymentToken, YEAR_IN_SECONDS } from '../../plugins/gns/constants';
import { getGnsContracts } from '../../plugins/gns/adapters/contracts';
import type { WalletProvider } from '../../core/wallet/wallet-provider';
import type { GnsApiAdapter, RegistrationQuoteResponse } from '../../plugins/gns/adapters/types';

const ZERO_HASH = ('0x' + '0'.repeat(64)) as `0x${string}`;
const FAKE_COMMITMENT = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
const OWNER = '0xC1fc8505071FD7eBb0b98bF9fb11C63A8d3ecdCe' as `0x${string}`;

/**
 * Recording wallet — captures the args handed to `callContract` so the
 * test can assert what payment tuple the SDK is putting into the
 * commit hash. `makeCommitment` returns a deterministic fixed hash so
 * the rest of the commit flow proceeds normally.
 */
class RecordingWallet implements WalletProvider {
  readonly callContractCalls: Array<{
    method: string;
    args: readonly unknown[];
  }> = [];
  readonly writeContractCalls: Array<{
    method: string;
    args: readonly unknown[];
  }> = [];
  async getAddress(): Promise<string> {
    return OWNER;
  }
  async getNetwork(): Promise<string> {
    return 'goat-mainnet';
  }
  async getChainId(): Promise<number> {
    return 2345;
  }
  async getBalance(): Promise<string> {
    return '0';
  }
  async getErc20Balance(): Promise<string> {
    return '0';
  }
  async transferNative(): Promise<{ txHash: string }> {
    return { txHash: '0xn' };
  }
  async transferErc20(): Promise<{ txHash: string }> {
    return { txHash: '0xe' };
  }
  async approveErc20(): Promise<{ txHash: string }> {
    return { txHash: '0xa' };
  }
  async signTypedData(): Promise<string> {
    return '0xs';
  }
  async callContract(_address: string, _abi: string[], method: string, args: readonly unknown[]): Promise<unknown> {
    this.callContractCalls.push({ method, args });
    if (method === 'makeCommitment') return FAKE_COMMITMENT;
    throw new Error(`unexpected callContract: ${method}`);
  }
  async writeContract(
    _address: string,
    _abi: string[],
    method: string,
    args: readonly unknown[],
  ): Promise<{ txHash: string }> {
    this.writeContractCalls.push({ method, args });
    return { txHash: '0xw' };
  }
  async deployContract(): Promise<{ txHash: string; address: string }> {
    throw new Error('not used');
  }
}

class StubGnsApi implements GnsApiAdapter {
  readonly quoteCalls: Array<{ name: string; years: number; tokenContract?: string }> = [];
  /** USDC has 6 decimals on GOAT mainnet (per contracts.defaults.ts:62). */
  goatPriceWei = '5000000'; // 5 USDC at 6 decimals
  async search(): Promise<never> {
    throw new Error('not used');
  }
  async details(): Promise<never> {
    throw new Error('not used');
  }
  async quote(input: { name: string; years: number; tokenContract?: string }): Promise<RegistrationQuoteResponse> {
    this.quoteCalls.push({
      name: input.name,
      years: input.years,
      tokenContract: input.tokenContract,
    });
    const durationSeconds = (BigInt(input.years) * YEAR_IN_SECONDS).toString();
    return {
      name: input.name,
      years: input.years,
      durationSeconds,
      currency: 'USDC',
      decimals: 6,
      registrationFee: '5.0',
      estimatedGas: '0',
      total: '5.0',
      totalWei: this.goatPriceWei,
    };
  }
  async myNames(): Promise<never> {
    throw new Error('not used');
  }
  async x402Config(): Promise<never> {
    throw new Error('not used');
  }
  async createX402Order(): Promise<never> {
    throw new Error('not used');
  }
  async getX402Order(): Promise<never> {
    throw new Error('not used');
  }
  async submitX402Signature(): Promise<never> {
    throw new Error('not used');
  }
}

function buildRuntime(api: GnsApiAdapter, wallet: WalletProvider) {
  const contracts = getGnsContracts('goat-mainnet');
  const provider = new ActionProvider();
  provider.register(estimatePriceAction(api));
  provider.register(commitAction(contracts, wallet));
  const policy = new PolicyEngine({
    allowedNetworks: ['goat-mainnet'],
    maxRiskWithoutConfirm: 'low',
    writeEnabled: true,
  });
  const runtime = new ExecutionRuntime(policy, { maxRetries: 0, retryDelayMs: 10 });
  const context = {
    traceId: 'trace_x402_register_commit',
    network: 'goat-mainnet',
    now: Date.now(),
  };
  return { provider, runtime, context, contracts };
}

describe('gns x402-register: commit hash binds the GOAT-side stablecoin + quoted amount', () => {
  it('reproduces the fixed CLI flow: resolve symbol → quote → commit, and the commit hash binds (GOAT-side USDT, totalWei) — NOT (publicResolver, 0)', async () => {
    // Inputs match the user's failing command:
    //   --pay-chain 56 --pay-token USDT --pay-token-contract 0x55d39…7955
    const payTokenSymbol = 'USDT';
    const name = 'newagent';
    const years = 1;
    const networkKey = 'goat-mainnet' as const;

    const api = new StubGnsApi();
    // USDT has 6 decimals on GOAT mainnet — match what the backend would
    // quote in the real path (so a future divergence would surface here).
    api.goatPriceWei = '5000000';

    const wallet = new RecordingWallet();
    const { provider, runtime, context } = buildRuntime(api, wallet);

    // Step 1 — resolve GOAT-side token (no API/chain call; an in-memory lookup).
    const goatToken = resolveGnsPaymentToken(networkKey, payTokenSymbol);
    expect(goatToken).toBeDefined();
    // Concrete on-chain mainnet USDT — `payments.service.ts` would resolve
    // the same address from the same symbol.
    expect(goatToken!.address.toLowerCase()).toBe('0xE1AD845D93853fff44990aE0DcecD8575293681e'.toLowerCase());
    expect(goatToken!.decimals).toBe(6);

    // Step 2 — quote via the same /names/quote endpoint the backend uses
    // internally, parameterized by the GOAT-side token address.
    const quoteRun = await runtime.run(
      provider.get('goat.gns.estimatePrice'),
      context,
      { name, years, tokenContract: goatToken!.address },
      { confirmed: true },
    );
    expect(quoteRun.ok).toBe(true);
    expect(api.quoteCalls).toHaveLength(1);
    expect(api.quoteCalls[0]).toEqual({
      name: 'newagent.goat',
      years,
      tokenContract: goatToken!.address,
    });
    const goatAmountWei = (quoteRun.output as { totalWei: string }).totalWei;
    expect(goatAmountWei).toBe('5000000');

    // Step 3 — commit with the resolved token + quoted amount.
    const commitRun = await runtime.run(
      provider.get('goat.gns.commit'),
      context,
      {
        name,
        owner: OWNER,
        years,
        paymentTokenAddress: goatToken!.address,
        paymentTokenSymbol: goatToken!.symbol,
        amountWei: goatAmountWei,
      },
      { confirmed: true, revealedFields: ['secret'] },
    );
    expect(commitRun.ok).toBe(true);

    // Critical regression assertions — what tuple did the SDK feed into
    // the on-chain `makeCommitment` view? This is the value the backend
    // re-derives in createRegistrationOrder; the two MUST match.
    const makeCommitmentCall = wallet.callContractCalls.find((c) => c.method === 'makeCommitment');
    expect(makeCommitmentCall, 'commitAction must call makeCommitment').toBeDefined();
    const [, paymentTuple] = makeCommitmentCall!.args as readonly [readonly unknown[], readonly [string, bigint]];

    // Post-fix: paymentToken = GOAT-side USDT (NOT publicResolver, NOT
    // x402Adaptor, NOT BSC USDT).
    expect(paymentTuple[0].toLowerCase()).toBe(goatToken!.address.toLowerCase());
    expect(paymentTuple[0].toLowerCase()).not.toBe('0xD56644B440B6d0326dc777a92FB2A0d9FdB4e59D'.toLowerCase()); // publicResolver
    expect(paymentTuple[0].toLowerCase()).not.toBe('0xC0cEB3b632B0264b739BE115604D1911917d5471'.toLowerCase()); // x402Adaptor
    expect(paymentTuple[0].toLowerCase()).not.toBe('0x55d398326f99059ff775485246999027b3197955'.toLowerCase()); // BSC USDT (source-chain token)

    // Post-fix: maxPaymentAmount = quoted GOAT-side totalWei (NOT 0).
    expect(paymentTuple[1]).toBe(5_000_000n);

    // Sanity — the commit submission also went on-chain with the same hash.
    const onChainCommit = wallet.writeContractCalls.find((c) => c.method === 'commit');
    expect(onChainCommit).toBeDefined();
    expect(onChainCommit!.args[0]).toBe(FAKE_COMMITMENT);
  });

  it('rejects the legacy bug shape — verifies what the test would catch', () => {
    // Sanity that the bug-shape constants we negate above are real and
    // distinct from the post-fix values. If GNS_PAYMENT_TOKENS or the
    // public registry constants ever change, this test fails loud
    // rather than silently flipping the regression's polarity.
    const goatUsdt = resolveGnsPaymentToken('goat-mainnet', 'USDT');
    const contracts = getGnsContracts('goat-mainnet');
    expect(goatUsdt!.address.toLowerCase()).not.toBe(contracts.publicResolver.toLowerCase());
    expect(goatUsdt!.address.toLowerCase()).not.toBe(contracts.x402Adaptor.toLowerCase());
    expect(goatUsdt!.address.toLowerCase()).not.toBe(ZERO_HASH.slice(0, 42));
  });

  it('normalizes merchant-style aliases (TUSDT → USDT) — the canonical symbol must be forwarded to createOrder', () => {
    // Codex P2 + Claude P1: the backend rejects when
    // `requestedSymbol.toUpperCase() !== canonicalSymbol`
    // (payments.service.ts:266-272). Earlier the CLI forwarded the raw
    // user-supplied `--pay-token` (`TUSDT`) to `createOrder` while
    // committing with the canonical symbol (`USDT`), so the commit-hash
    // path passed and the order-validation path failed. The fix forwards
    // `goatPaymentToken.symbol` (canonical) to both.
    const aliasResolved = resolveGnsPaymentToken('goat-testnet', 'TUSDT');
    const directResolved = resolveGnsPaymentToken('goat-testnet', 'USDT');
    expect(aliasResolved).toBeDefined();
    expect(aliasResolved!.symbol).toBe('USDT');
    expect(aliasResolved).toEqual(directResolved);
    // Mainnet: USDC and USDT have no merchant alias, so the canonical
    // form is identical to the raw symbol — confirms the canonical-forward
    // strategy is a no-op for the common case.
    const mainnetUsdt = resolveGnsPaymentToken('goat-mainnet', 'USDT');
    expect(mainnetUsdt!.symbol).toBe('USDT');
    const mainnetUsdc = resolveGnsPaymentToken('goat-mainnet', 'USDC');
    expect(mainnetUsdc!.symbol).toBe('USDC');
  });

  it('matches the GNS_PAYMENT_TOKENS table the backend mirrors (parity check)', () => {
    // The backend's contracts.defaults.ts holds the authoritative
    // (symbol -> GOAT-side address, decimals) mapping. The SDK mirrors
    // it in GNS_PAYMENT_TOKENS. If either side drifts, commits and
    // backend re-derivations would silently diverge for the affected
    // symbol. Lock the current mainnet pair.
    const mainnet = GNS_PAYMENT_TOKENS['goat-mainnet'];
    const usdc = mainnet.find((t) => t.symbol === 'USDC');
    const usdt = mainnet.find((t) => t.symbol === 'USDT');
    expect(usdc).toEqual({
      symbol: 'USDC',
      address: '0x3022b87ac063DE95b1570F46f5e470F8B53112D8',
      decimals: 6,
    });
    expect(usdt).toEqual({
      symbol: 'USDT',
      address: '0xE1AD845D93853fff44990aE0DcecD8575293681e',
      decimals: 6,
    });
  });
});

describe('agentkit-gns x402-register: CLI plan ordering', () => {
  // Bootstrapping tsx through the bin shim is slow under full-suite
  // parallelism; mirror cli-gns.test.ts headroom.
  vi.setConfig({ testTimeout: 30_000 });

  const exec = promisify(execFile);
  const REPO_ROOT = resolve(__dirname, '..', '..');
  const BIN = resolve(REPO_ROOT, 'bin', 'gns.mjs');

  it('the dry-run plan invokes waitForCommitment between commit and x402.createOrder', async () => {
    // Codex P1: the backend's createRegistrationOrder calls
    // ensureCommitmentReady (names.service.ts:300-304) which rejects
    // until block.timestamp ≥ revealAt (minCommitmentAge = 60s). The CLI
    // must poll waitForCommitment between commit and createOrder; without
    // this, every fresh commit fails the next createOrder call.
    //
    // Probe the dry-run --json output to assert the plan ordering rather
    // than spinning up a full chain mock.
    const { stdout, stderr } = await exec(
      'node',
      [
        BIN,
        '--dry-run',
        '--json',
        '--auto-confirm',
        'x402-register',
        'newagent',
        '--pay-chain',
        '56',
        '--pay-token',
        'USDT',
        '--pay-token-contract',
        '0x55d398326f99059fF775485246999027B3197955',
      ],
      { cwd: REPO_ROOT, timeout: 25_000, env: process.env },
    ).catch((err) => {
      const e = err as { stdout?: string; stderr?: string };
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    });
    void stderr;

    expect(stdout, `expected non-empty stdout, got stderr: ${stderr}`).toBeTruthy();
    const parsed = JSON.parse(stdout) as { dryRun?: boolean; plan?: string[] };
    expect(parsed.dryRun).toBe(true);
    expect(Array.isArray(parsed.plan)).toBe(true);
    const plan = parsed.plan!;
    const commitIdx = plan.indexOf('commit');
    const waitIdx = plan.indexOf('waitForCommitment');
    const createOrderIdx = plan.indexOf('x402.createOrder');
    expect(commitIdx, 'plan must include commit').toBeGreaterThanOrEqual(0);
    expect(waitIdx, 'plan must include waitForCommitment').toBeGreaterThanOrEqual(0);
    expect(createOrderIdx, 'plan must include x402.createOrder').toBeGreaterThanOrEqual(0);
    expect(commitIdx).toBeLessThan(waitIdx);
    expect(waitIdx).toBeLessThan(createOrderIdx);
  });

  it('rejects invalid wait polling flags before env / wallet setup', async () => {
    // P2 regression: invalid Number(...) results used to become NaN after
    // the GOAT commit, creating an unbounded rapid-poll loop. Validate the
    // flags before any env checks or chain writes.
    for (const [flag, value] of [
      ['--wait-timeout', 'abc'],
      ['--poll-interval', '0'],
    ] as const) {
      const result = await exec(
        'node',
        [
          BIN,
          '--json',
          '--auto-confirm',
          'x402-register',
          'newagent',
          '--pay-chain',
          '56',
          '--pay-token',
          'USDT',
          '--pay-token-contract',
          '0x55d398326f99059fF775485246999027B3197955',
          flag,
          value,
        ],
        { cwd: REPO_ROOT, timeout: 25_000, env: process.env },
      )
        .then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }))
        .catch((err) => {
          const e = err as { code?: number; stdout?: string; stderr?: string };
          return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
        });

      expect(result.code, `${flag}=${value} should fail as user input`).toBe(1);
      expect(result.stderr).toMatch(new RegExp(flag.replace('--', '--')));
      expect(result.stderr).not.toMatch(/GOAT_PRIVATE_KEY|PAYMENT_CHAIN_RPC_URL/);
    }
  });
});
