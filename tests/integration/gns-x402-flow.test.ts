import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ActionProvider } from '../../providers/action-provider';
import { PolicyEngine } from '../../core/policy/policy-engine';
import { ExecutionRuntime } from '../../core/runtime/execution-runtime';
import { x402CreateOrderAction } from '../../plugins/gns/actions/x402-create-order';
import { x402SubmitSignatureAction } from '../../plugins/gns/actions/x402-submit-signature';
import { x402PayOrderAction } from '../../plugins/gns/actions/x402-pay-order';
import { x402GetOrderStatusAction } from '../../plugins/gns/actions/x402-get-order-status';
import type { GnsApiAdapter, X402OrderResponse, X402OrderStatusResponse } from '../../plugins/gns/adapters/types';
import type { PayerWalletAdapter } from '../../plugins/x402/adapters/types';
import type { WalletProvider } from '../../core/wallet/wallet-provider';

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'gns-x402-register-order.json',
);
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as X402OrderResponse;

// ─────────────────────────────────────────────────────────────────────────────
// Typed stubs (no `any`).
// ─────────────────────────────────────────────────────────────────────────────

const NOT_USED = (name: string) => () => {
  throw new Error(`StubApi.${name} not used in this test`);
};

class StubApi implements GnsApiAdapter {
  submitOutcome: 'authorized' | 'failed' = 'authorized';
  /**
   * Lifecycle starts at CHECKOUT_VERIFIED — the real GNS x402 backend
   * `OrderStatus` enum (`goat-ens/backend/lib/goatx402-sdk-server/src/types.ts:69`)
   * has no `PAYMENT_PENDING`; CHECKOUT_VERIFIED is the post-submitSignature,
   * pre-payment terminal state where the action accepts a payOrder call.
   * Test code that needs a later state can mutate this — and StubPayer's
   * `transferToken` mock flips it to PAYMENT_CONFIRMED so the subsequent
   * getOrderStatus call in the happy path returns the expected post-pay
   * intermediate value (INVOICED would only follow on the real backend once
   * the adaptor callback fires on GOAT).
   */
  orderStatus: X402OrderStatusResponse['status'] = 'CHECKOUT_VERIFIED';
  search = NOT_USED('search') as GnsApiAdapter['search'];
  details = NOT_USED('details') as GnsApiAdapter['details'];
  quote = NOT_USED('quote') as GnsApiAdapter['quote'];
  myNames = NOT_USED('myNames') as GnsApiAdapter['myNames'];
  /**
   * payOrder calls x402Config for its tokenContract defense-in-depth check
   * (Issue #3 Round 2 Codex P1). Return a config that includes the fixture's
   * source chain + token so the happy-path test passes; tests that exercise
   * the tokenContract mismatch can mutate this.
   */
  async x402Config() {
    return {
      merchantId: 'goat_name_service',
      merchantName: 'GOAT Name Service',
      receiveType: 'DELEGATE',
      chains: [
        {
          chainId: fixture.payChainId,
          name: 'base-mainnet',
          tokens: [
            {
              symbol: fixture.tokenSymbol || 'USDC',
              contract: fixture.tokenContract,
              decimals: 6,
            },
          ],
        },
      ],
    };
  }
  async createX402Order(): Promise<X402OrderResponse> {
    return fixture;
  }
  async getX402Order(orderId: string): Promise<X402OrderStatusResponse> {
    return {
      orderId,
      status: this.orderStatus,
      txHash: this.orderStatus === 'PAYMENT_CONFIRMED' ? '0xpayment_tx' : undefined,
      confirmedAt: this.orderStatus === 'PAYMENT_CONFIRMED' ? Math.floor(Date.now() / 1000) : undefined,
      raw: fixture,
    };
  }
  async submitX402Signature() {
    return { status: this.submitOutcome };
  }
}

class StubPayer implements PayerWalletAdapter {
  signed = '';
  transferred: { tokenAddress: string; to: string; amount: string } | null = null;
  /** Set by `buildRuntime` so transferToken can flip the order lifecycle. */
  api?: StubApi;
  /**
   * Issue #3 R4 (Codex P5): payOrder now binds `message.payer` to
   * `payer.getAddress()` when present, in addition to `wallet.getAddress()`.
   * Default to the same address as `makeSourceWallet` returns so the
   * happy path passes; tests that exercise the 3-way mismatch override.
   */
  payerAddress = '0x39573c7798c3d92Ec4f5e5d6A0C2f5E6B7C8d9e0';
  async normalizeAuthorization(s: string) {
    return s;
  }
  async signCalldataTypedData(): Promise<string> {
    this.signed = '0xstubsignature';
    return this.signed;
  }
  async getAddress(): Promise<string> {
    return this.payerAddress;
  }
  async transferToken(input: { tokenAddress: string; to: string; amount: string }) {
    this.transferred = input;
    if (this.api) this.api.orderStatus = 'PAYMENT_CONFIRMED';
    return { txHash: '0xstub_transfer_tx' };
  }
}

function makeSourceWallet(chainId: number): WalletProvider {
  return {
    async getAddress() {
      return '0x39573c7798c3d92Ec4f5e5d6A0C2f5E6B7C8d9e0';
    },
    async getNetwork() {
      return 'base-mainnet';
    },
    async getChainId() {
      return chainId;
    },
    async getBalance() {
      return '0';
    },
    async getErc20Balance() {
      return '0';
    },
    async transferNative() {
      return { txHash: '0xn' };
    },
    async transferErc20() {
      return { txHash: '0xe' };
    },
    async approveErc20() {
      return { txHash: '0xa' };
    },
    async signTypedData() {
      return '0xs';
    },
    async callContract() {
      return '0x';
    },
    async writeContract() {
      return { txHash: '0xw' };
    },
    async deployContract() {
      throw new Error('not used');
    },
  };
}

function buildRuntime(api: GnsApiAdapter, payer: PayerWalletAdapter, wallet: WalletProvider) {
  if (api instanceof StubApi && payer instanceof StubPayer) {
    // Connect payer → api so `transferToken` flips the order lifecycle
    // and subsequent getOrderStatus returns PAYMENT_CONFIRMED.
    payer.api = api;
  }
  const provider = new ActionProvider();
  provider.register(x402CreateOrderAction(api));
  provider.register(x402SubmitSignatureAction(api, payer));
  provider.register(x402PayOrderAction(api, payer, wallet));
  provider.register(x402GetOrderStatusAction(api));
  const policy = new PolicyEngine({
    // x402 actions declare wildcard networks; the runtime context's network
    // just needs to be in the policy allowlist.
    allowedNetworks: ['goat-testnet', 'base-mainnet'],
    maxRiskWithoutConfirm: 'low',
    writeEnabled: true,
  });
  const runtime = new ExecutionRuntime(policy, { maxRetries: 0, retryDelayMs: 10 });
  const context = { traceId: 'trace_gns_x402', network: 'base-mainnet', now: Date.now() };
  return { provider, runtime, context };
}

describe('gns x402 cross-chain flow (fixture-backed)', () => {
  it('createOrder → submitSignature → payOrder → getOrderStatus', async () => {
    const api = new StubApi();
    const happyOrderId = `${fixture.orderId}:happy`;
    api.createX402Order = async () => ({ ...fixture, orderId: happyOrderId });
    const payer = new StubPayer();
    const wallet = makeSourceWallet(fixture.payChainId);
    const { provider, runtime, context } = buildRuntime(api, payer, wallet);

    const created = await runtime.run(
      provider.get('goat.gns.x402.createOrder'),
      context,
      {
        name: 'alice',
        owner: '0x39573c7798c3d92Ec4f5e5d6A0C2f5E6B7C8d9e0',
        payer: '0x39573c7798c3d92Ec4f5e5d6A0C2f5E6B7C8d9e0',
        years: 1,
        settlementChainId: fixture.payChainId,
        settlementTokenSymbol: fixture.tokenSymbol,
        settlementTokenContract: fixture.tokenContract,
        secret: '0x' + '11'.repeat(32),
      },
      { confirmed: true },
    );
    expect(created.ok).toBe(true);
    expect(created.output!.orderId).toBe(happyOrderId);
    expect(created.output!.calldataSignRequest.primaryType).toBe('Permit2CallbackData');

    const signed = await runtime.run(
      provider.get('goat.gns.x402.submitSignature'),
      context,
      {
        orderId: created.output!.orderId,
        calldataSignRequest: created.output!.calldataSignRequest,
      },
      { confirmed: true },
    );
    expect(signed.ok).toBe(true);
    expect(signed.output!.status).toBe('authorized');
    expect(payer.signed).toBe('0xstubsignature');

    const paid = await runtime.run(
      provider.get('goat.gns.x402.payOrder'),
      context,
      {
        orderId: created.output!.orderId,
        // payOrder now takes payment routing fields from createOrder
        // response as inputs (Issue #3 fix). The status endpoint is a
        // lifecycle-only projection; it does NOT carry payToAddress /
        // expiresAt / source-chain tokenContract. calldataSignRequest
        // is threaded for the proof-binding gate (Issue #3 R2).
        payChainId: created.output!.payChainId,
        tokenContract: created.output!.tokenContract,
        payToAddress: created.output!.payToAddress,
        amountWei: created.output!.amountWei,
        expiresAt: created.output!.expiresAt,
        calldataSignRequest: created.output!.calldataSignRequest,
      },
      { confirmed: true },
    );
    expect(paid.ok).toBe(true);
    expect(paid.output!.txHash).toBe('0xstub_transfer_tx');
    expect(payer.transferred).toEqual({
      tokenAddress: fixture.tokenContract,
      to: fixture.payToAddress,
      amount: fixture.amountWei,
    });

    const status = await runtime.run(provider.get('goat.gns.x402.getOrderStatus'), context, {
      orderId: created.output!.orderId,
    });
    expect(status.ok).toBe(true);
    expect(status.output!.status).toBe('PAYMENT_CONFIRMED');
  });

  // Reusable payOrder input shape — mirrors what the CLI / example feed
  // from the createOrder response. Keep tests focused on the gate logic
  // by varying status / chain / payer / routing state, not these full
  // baseline fields. calldataSignRequest is the signed merchant
  // authorization (Issue #3 R2 defense-in-depth source); the fixture's
  // message.owner matches fixture.payToAddress so the happy path passes.
  const payOrderInput = {
    orderId: fixture.orderId,
    payChainId: fixture.payChainId,
    tokenContract: fixture.tokenContract,
    payToAddress: fixture.payToAddress,
    amountWei: fixture.amountWei,
    expiresAt: fixture.expiresAt,
    calldataSignRequest: fixture.calldataSignRequest,
  };

  it('payOrder rejects when wallet is on the wrong source chain', async () => {
    const api = new StubApi();
    const payer = new StubPayer();
    const wallet = makeSourceWallet(1); // wrong chainId
    const { provider, runtime, context } = buildRuntime(api, payer, wallet);
    const res = await runtime.run(provider.get('goat.gns.x402.payOrder'), context, payOrderInput, {
      confirmed: true,
    });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('INVALID_INPUT');
    expect(res.error).toMatch(/chain_mismatch/);
    expect(payer.transferred).toBeNull();
  });

  it('payOrder refuses to double-pay an already-confirmed order (status gate)', async () => {
    const api = new StubApi();
    api.orderStatus = 'PAYMENT_CONFIRMED'; // post-payment intermediate state — must not re-pay
    const payer = new StubPayer();
    const wallet = makeSourceWallet(fixture.payChainId);
    const { provider, runtime, context } = buildRuntime(api, payer, wallet);
    const res = await runtime.run(provider.get('goat.gns.x402.payOrder'), context, payOrderInput, {
      confirmed: true,
    });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('INVALID_INPUT');
    expect(res.error).toMatch(/order_not_payable/);
    expect(payer.transferred).toBeNull();
  });

  it('payOrder refuses to pay a terminal-failed order (FAILED / EXPIRED / CANCELLED)', async () => {
    // Issue #3: the new explicit-CHECKOUT_VERIFIED gate must also reject
    // backend terminal failure states, not silently re-broadcast on them.
    for (const dead of ['FAILED', 'EXPIRED', 'CANCELLED'] as const) {
      const api = new StubApi();
      api.orderStatus = dead;
      const payer = new StubPayer();
      const wallet = makeSourceWallet(fixture.payChainId);
      const { provider, runtime, context } = buildRuntime(api, payer, wallet);
      const res = await runtime.run(provider.get('goat.gns.x402.payOrder'), context, payOrderInput, {
        confirmed: true,
      });
      expect(res.ok, `dead status ${dead} must be rejected`).toBe(false);
      expect(res.errorCode).toBe('INVALID_INPUT');
      expect(res.error).toMatch(/order_not_payable/);
      expect(payer.transferred).toBeNull();
    }
  });

  it('payOrder fails closed when order status is missing/empty (no truthy-gate bypass)', async () => {
    // Regression: `X402OrderLifecycle` widens to `string`, so an empty
    // status is type-valid. A negated gate (`!== 'PAID'`-style) would let
    // it through; the explicit `status === 'CHECKOUT_VERIFIED'` gate rejects.
    const api = new StubApi();
    api.orderStatus = '' as X402OrderStatusResponse['status'];
    const payer = new StubPayer();
    const wallet = makeSourceWallet(fixture.payChainId);
    const { provider, runtime, context } = buildRuntime(api, payer, wallet);
    const res = await runtime.run(provider.get('goat.gns.x402.payOrder'), context, payOrderInput, {
      confirmed: true,
    });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('INVALID_INPUT');
    expect(res.error).toMatch(/order_not_payable/);
    expect(payer.transferred).toBeNull();
  });

  it('payOrder refuses to pay an order inside the expiry safety margin', async () => {
    // Issue #3 (verified during Round 1 review): expiresAt now comes from
    // input (was: parsed from status response). Cover the safety-margin
    // check explicitly so an old/expiring order can never be paid by accident.
    const api = new StubApi();
    const payer = new StubPayer();
    const wallet = makeSourceWallet(fixture.payChainId);
    const { provider, runtime, context } = buildRuntime(api, payer, wallet);
    const res = await runtime.run(
      provider.get('goat.gns.x402.payOrder'),
      context,
      { ...payOrderInput, expiresAt: Math.floor(Date.now() / 1000) + 5 }, // inside the 30s margin
      { confirmed: true },
    );
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('INVALID_INPUT');
    expect(res.error).toMatch(/expiry margin/);
    expect(payer.transferred).toBeNull();
  });

  it('payOrder rejects when input.payChainId mismatches the on-record order proof chainId (defense in depth)', async () => {
    // Issue #3 Round 1 (Codex P1): the action takes payment routing fields
    // as inputs, but must also bind those inputs to the on-record order
    // proof so a bad/stale caller cannot force a transfer on the wrong
    // chain. The status proof exposes chainId; payOrder must reject any
    // mismatch before broadcasting.
    const api = new StubApi();
    const payer = new StubPayer();
    // Wallet matches the input (so chain-mismatch check on wallet passes)…
    const wallet = makeSourceWallet(1234);
    const { provider, runtime, context } = buildRuntime(api, payer, wallet);
    const res = await runtime.run(
      provider.get('goat.gns.x402.payOrder'),
      context,
      { ...payOrderInput, payChainId: 1234, payToAddress: payOrderInput.payToAddress },
      // …but the fixture's payChainId is 8453, so the proof binding catches the lie.
      { confirmed: true },
    );
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('INVALID_INPUT');
    expect(res.error).toMatch(/order_proof_mismatch/);
    expect(payer.transferred).toBeNull();
  });

  it('payOrder rejects when input.amountWei mismatches the on-record order proof amountWei', async () => {
    const api = new StubApi();
    const payer = new StubPayer();
    const wallet = makeSourceWallet(fixture.payChainId);
    const { provider, runtime, context } = buildRuntime(api, payer, wallet);
    const res = await runtime.run(
      provider.get('goat.gns.x402.payOrder'),
      context,
      { ...payOrderInput, amountWei: '9999999' }, // lie about the amount
      { confirmed: true },
    );
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('INVALID_INPUT');
    expect(res.error).toMatch(/order_proof_mismatch/);
    expect(payer.transferred).toBeNull();
  });

  it('payOrder rejects when input.payToAddress diverges from calldataSignRequest.message.owner (R2 P1 defense — signed-authorization binding)', async () => {
    // Issue #3 Round 2 Codex P1: payToAddress is a caller-supplied input
    // that the status proof doesn't carry. Defense uses the backend's signed
    // calldataSignRequest.message.owner as a cross-check anchor — a caller
    // that tries to redirect funds by lying about payToAddress must ALSO
    // forge the calldata's owner field, which the on-chain adaptor verifier
    // would reject anyway (and we fail fast here, before any transfer).
    const api = new StubApi();
    const payer = new StubPayer();
    const wallet = makeSourceWallet(fixture.payChainId);
    const { provider, runtime, context } = buildRuntime(api, payer, wallet);
    // Fixture now uses the production Permit2CallbackData shape which
    // includes `owner` (= fixture.payToAddress). A caller who tries to
    // redirect funds by lying about payToAddress must leave the calldata's
    // owner intact (otherwise the signature verification on-chain would
    // fail anyway), so the mismatch fires this SDK-side guard before any
    // transfer is broadcast.
    const tamperedInput = {
      ...payOrderInput,
      payToAddress: '0x000000000000000000000000000000000000dEaD' as `0x${string}`, // attacker redirect
      // calldataSignRequest left as-is (fixture has message.owner = real payToAddress)
    };
    const res = await runtime.run(provider.get('goat.gns.x402.payOrder'), context, tamperedInput, {
      confirmed: true,
    });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('INVALID_INPUT');
    expect(res.error).toMatch(/order_proof_mismatch/);
    expect(res.error).toMatch(/payToAddress/);
    expect(payer.transferred).toBeNull();
  });

  it('payOrder fails closed when calldataSignRequest.message omits owner (no implicit-skip bypass — R3 Codex P1)', async () => {
    // The Round 2 implementation made the owner check conditional, which
    // silently skipped on shapes that don't carry owner (e.g., older
    // Eip3009CallbackData). R3 makes the check mandatory: missing owner
    // means we cannot cryptographically bind payToAddress, so refuse.
    const api = new StubApi();
    const payer = new StubPayer();
    const wallet = makeSourceWallet(fixture.payChainId);
    const { provider, runtime, context } = buildRuntime(api, payer, wallet);
    const res = await runtime.run(
      provider.get('goat.gns.x402.payOrder'),
      context,
      {
        ...payOrderInput,
        calldataSignRequest: {
          ...fixture.calldataSignRequest,
          message: { payer: fixture.fromAddress, amount: fixture.amountWei }, // owner intentionally absent
        },
      },
      { confirmed: true },
    );
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('INVALID_INPUT');
    expect(res.error).toMatch(/calldataSignRequest\.message\.owner/);
    expect(payer.transferred).toBeNull();
  });

  it('payOrder rejects when calldataSignRequest.message.payer diverges from the configured wallet (R5+R6 — message.payer binding)', async () => {
    // The 3-way binding (wallet ≡ payer ≡ message.payer) is encoded as two
    // checks: (a) wallet ≡ message.payer, (b) wallet ≡ payer.getAddress().
    // By transitivity payer ≡ message.payer is also enforced. R6 Claude
    // correctly noted that an earlier explicit `payerAddr !== messagePayer`
    // check was unreachable dead code; this test now covers check (a) —
    // the message.payer divergence case — directly. The wallet+payer
    // mismatch case is covered by the dedicated test below.
    const api = new StubApi();
    const payer = new StubPayer();
    const wallet = makeSourceWallet(fixture.payChainId);
    const { provider, runtime, context } = buildRuntime(api, payer, wallet);
    const tamperedInput = {
      ...payOrderInput,
      calldataSignRequest: {
        ...fixture.calldataSignRequest,
        message: {
          ...fixture.calldataSignRequest.message,
          payer: '0x000000000000000000000000000000000000bABE', // ≠ wallet
        },
      },
    };
    const res = await runtime.run(provider.get('goat.gns.x402.payOrder'), context, tamperedInput, {
      confirmed: true,
    });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('INVALID_INPUT');
    expect(res.error).toMatch(/calldataSignRequest\.message\.payer/);
    expect(res.error).toMatch(/does not match the signed payer authorization/);
    expect(payer.transferred).toBeNull();
  });

  it('payOrder fails closed when OrderProof.chainId is missing (F2 — no silent skip)', async () => {
    // F2: previously the proof-binding skipped silently when the field was
    // absent or wrong type, which is fail-open — a malformed upstream
    // response would let the transfer through unbound. Now strict.
    const api = new StubApi();
    api.getX402Order = async (orderId: string) => ({
      orderId,
      status: 'CHECKOUT_VERIFIED',
      raw: {
        // chainId / payChainId intentionally omitted to simulate malformed upstream
        amountWei: fixture.amountWei,
        fromAddress: fixture.fromAddress,
      },
    });
    const payer = new StubPayer();
    const wallet = makeSourceWallet(fixture.payChainId);
    const { provider, runtime, context } = buildRuntime(api, payer, wallet);
    const res = await runtime.run(provider.get('goat.gns.x402.payOrder'), context, payOrderInput, {
      confirmed: true,
    });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('ADAPTER_REQUEST_FAILED');
    expect(res.error).toMatch(/order_proof_malformed.*payChainId\/chainId/);
    expect(payer.transferred).toBeNull();
  });

  it('payOrder fails closed when OrderProof.chainId arrives as a numeric STRING (F2 Round 1 Codex P1 — no silent coercion)', async () => {
    // Round 1 Codex P1: the F2 fix used Number(proofChainIdRaw) which
    // silently coerces a string `"8453"` into a number, bypassing the
    // wrong-type ADAPTER_REQUEST_FAILED contract. Backend's OrderProof
    // type says `chainId: number`; a string here is a real malformed
    // response and must surface as such.
    const api = new StubApi();
    api.getX402Order = async (orderId: string) => ({
      orderId,
      status: 'CHECKOUT_VERIFIED',
      raw: {
        chainId: String(fixture.payChainId), // STRING instead of number
        amountWei: fixture.amountWei,
        fromAddress: fixture.fromAddress,
      },
    });
    const payer = new StubPayer();
    const wallet = makeSourceWallet(fixture.payChainId);
    const { provider, runtime, context } = buildRuntime(api, payer, wallet);
    const res = await runtime.run(provider.get('goat.gns.x402.payOrder'), context, payOrderInput, {
      confirmed: true,
    });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('ADAPTER_REQUEST_FAILED');
    expect(res.error).toMatch(/order_proof_malformed.*payChainId.*not a positive integer/);
    expect(payer.transferred).toBeNull();
  });

  it('payOrder error message handles BigInt chainId safely (R2 Codex P2 — no JSON.stringify TypeError on BigInt)', async () => {
    // R2 Codex P2: BigInt values in raw fields would crash the error
    // constructor via JSON.stringify, shadowing the typed
    // ADAPTER_REQUEST_FAILED with a plain TypeError. Now uses String(...).
    const api = new StubApi();
    api.getX402Order = async (orderId: string) => ({
      orderId,
      status: 'CHECKOUT_VERIFIED',
      raw: {
        chainId: 8453n, // BigInt — must surface as typed error, not TypeError
        amountWei: fixture.amountWei,
        fromAddress: fixture.fromAddress,
      },
    });
    const payer = new StubPayer();
    const wallet = makeSourceWallet(fixture.payChainId);
    const { provider, runtime, context } = buildRuntime(api, payer, wallet);
    const res = await runtime.run(provider.get('goat.gns.x402.payOrder'), context, payOrderInput, {
      confirmed: true,
    });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('ADAPTER_REQUEST_FAILED');
    expect(res.error).toMatch(/order_proof_malformed.*payChainId.*typeof=bigint/);
    expect(payer.transferred).toBeNull();
  });

  it('payOrder fails closed when OrderProof.amountWei is wrong type (F2 — no silent skip)', async () => {
    const api = new StubApi();
    api.getX402Order = async (orderId: string) => ({
      orderId,
      status: 'CHECKOUT_VERIFIED',
      raw: {
        chainId: fixture.payChainId,
        amountWei: 3000000, // number instead of string — backend invariant violated
        fromAddress: fixture.fromAddress,
      },
    });
    const payer = new StubPayer();
    const wallet = makeSourceWallet(fixture.payChainId);
    const { provider, runtime, context } = buildRuntime(api, payer, wallet);
    const res = await runtime.run(provider.get('goat.gns.x402.payOrder'), context, payOrderInput, {
      confirmed: true,
    });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('ADAPTER_REQUEST_FAILED');
    expect(res.error).toMatch(/order_proof_malformed.*amountWei/);
    expect(payer.transferred).toBeNull();
  });

  it('payOrder fails closed when OrderProof.fromAddress is missing (F2 — no silent skip)', async () => {
    const api = new StubApi();
    api.getX402Order = async (orderId: string) => ({
      orderId,
      status: 'CHECKOUT_VERIFIED',
      raw: {
        chainId: fixture.payChainId,
        amountWei: fixture.amountWei,
        // fromAddress omitted
      },
    });
    const payer = new StubPayer();
    const wallet = makeSourceWallet(fixture.payChainId);
    const { provider, runtime, context } = buildRuntime(api, payer, wallet);
    const res = await runtime.run(provider.get('goat.gns.x402.payOrder'), context, payOrderInput, {
      confirmed: true,
    });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('ADAPTER_REQUEST_FAILED');
    expect(res.error).toMatch(/order_proof_malformed.*fromAddress/);
    expect(payer.transferred).toBeNull();
  });

  it('payOrder rejects when payer signer address diverges from wallet address (R4 Codex P5 — 3-way payer binding)', async () => {
    // Issue #3 R4 Codex P5: the transfer goes through `payer.transferToken`,
    // not `wallet.transferToken`. If wallet and payer wrap different
    // signers (e.g., test mis-wiring, or a service that injects a payer
    // adapter pointing to a different key), the wallet check passes but
    // the broadcasted tx is signed by a different key. Requires
    // payer.getAddress() === wallet.getAddress() === message.payer.
    const api = new StubApi();
    const payer = new StubPayer();
    payer.payerAddress = '0x000000000000000000000000000000000000bABE'; // different from wallet
    const wallet = makeSourceWallet(fixture.payChainId);
    const { provider, runtime, context } = buildRuntime(api, payer, wallet);
    const res = await runtime.run(provider.get('goat.gns.x402.payOrder'), context, payOrderInput, {
      confirmed: true,
    });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('INVALID_INPUT');
    expect(res.error).toMatch(/payer signer address.*does not match wallet address/);
    expect(payer.transferred).toBeNull();
  });

  it('payOrder fails closed when x402Config has no entry for the source chain (R3 Codex P2 — config binding)', async () => {
    // Previously degraded to "accept" on missing chain entry — silently
    // disabled the defense if config drifted. R3 makes this fail-closed.
    const api = new StubApi();
    // Override x402Config to return a config WITHOUT the fixture's chain.
    api.x402Config = (async () => ({
      merchantId: 'goat_name_service',
      merchantName: 'GOAT Name Service',
      receiveType: 'DELEGATE',
      chains: [{ chainId: 999, name: 'unknown', tokens: [] }],
    })) as GnsApiAdapter['x402Config'];
    const payer = new StubPayer();
    const wallet = makeSourceWallet(fixture.payChainId);
    const { provider, runtime, context } = buildRuntime(api, payer, wallet);
    const res = await runtime.run(provider.get('goat.gns.x402.payOrder'), context, payOrderInput, {
      confirmed: true,
    });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('INVALID_INPUT');
    expect(res.error).toMatch(/payChainId.*not in the merchant's x402Config/);
    expect(payer.transferred).toBeNull();
  });

  it('payOrder rejects when input.tokenContract is not in the merchant x402Config for the chain (R2 P1 defense — config binding)', async () => {
    // The status proof's tokenContract is the GOAT-side adaptor token, not
    // the source-chain ERC-20. We cross-check input.tokenContract against
    // the merchant's authoritative x402Config token list for the chain.
    const api = new StubApi();
    const payer = new StubPayer();
    const wallet = makeSourceWallet(fixture.payChainId);
    const { provider, runtime, context } = buildRuntime(api, payer, wallet);
    const res = await runtime.run(
      provider.get('goat.gns.x402.payOrder'),
      context,
      // A different token contract on the same chain (e.g., attacker's own ERC-20).
      { ...payOrderInput, tokenContract: '0x000000000000000000000000000000000000DEAD' as `0x${string}` },
      { confirmed: true },
    );
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('INVALID_INPUT');
    expect(res.error).toMatch(/order_proof_mismatch/);
    expect(res.error).toMatch(/supported tokens/);
    expect(payer.transferred).toBeNull();
  });

  it('payOrder dedupes concurrent calls for the same orderId (inflight Map, prevents double-pay TOCTOU)', async () => {
    // Issue #3 Round 1 (Claude P2): the module-scope inflight Map is the
    // only guard against the double-pay TOCTOU race. Two concurrent calls
    // for the same orderId must result in a single transfer broadcast.
    const api = new StubApi();
    const payer = new StubPayer();
    const wallet = makeSourceWallet(fixture.payChainId);
    const { provider, runtime, context } = buildRuntime(api, payer, wallet);
    const def = provider.get('goat.gns.x402.payOrder');
    let transferCount = 0;
    const origTransferToken = payer.transferToken.bind(payer);
    payer.transferToken = async (...args: Parameters<typeof origTransferToken>) => {
      transferCount += 1;
      return origTransferToken(...args);
    };
    // Fire two payOrder calls in parallel; both should resolve to the same
    // result, but only one transferToken broadcast should happen.
    const [a, b] = await Promise.all([
      runtime.run(def, context, payOrderInput, { confirmed: true }),
      runtime.run(def, context, payOrderInput, { confirmed: true }),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(transferCount, 'inflight Map must dedupe — only one source-chain transfer').toBe(1);
  });

  it('payOrder returns the first tx for a sequential retry while the backend status is still CHECKOUT_VERIFIED', async () => {
    // P1 regression: inflight only protects concurrent calls. After the
    // first transferToken resolves, the backend watcher may still report
    // CHECKOUT_VERIFIED for a few blocks; a same-process sequential retry
    // must not broadcast another source-chain transfer in that window.
    const api = new StubApi();
    const payer = new StubPayer();
    const wallet = makeSourceWallet(fixture.payChainId);
    const { provider, runtime, context } = buildRuntime(api, payer, wallet);
    const input = { ...payOrderInput, orderId: `${fixture.orderId}:sequential-retry` };
    let transferCount = 0;
    payer.transferToken = async (transferInput: { tokenAddress: string; to: string; amount: string }) => {
      transferCount += 1;
      payer.transferred = transferInput;
      // Intentionally do NOT flip api.orderStatus. This simulates the real
      // watcher lag where the transfer was broadcast but status is still
      // CHECKOUT_VERIFIED.
      return { txHash: `0xseq_${transferCount}` };
    };

    const first = await runtime.run(provider.get('goat.gns.x402.payOrder'), context, input, { confirmed: true });
    const second = await runtime.run(provider.get('goat.gns.x402.payOrder'), context, input, { confirmed: true });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.output!.txHash).toBe('0xseq_1');
    expect(second.output!.txHash).toBe('0xseq_1');
    expect(api.orderStatus).toBe('CHECKOUT_VERIFIED');
    expect(transferCount, 'sequential retry must reuse cached txHash').toBe(1);
  });

  it('payOrder refuses to reuse the cached tx when a sequential retry mutates payment routing', async () => {
    // P1 money-path guard: the paidOrders cache keys on
    // (payChainId, tokenContract, payToAddress, amountWei, walletAddr).
    // If a caller reuses the same orderId but flips any of these — e.g.
    // doubles the amountWei — returning the cached tx would silently
    // mask an inconsistent retry. Refuse with INVALID_INPUT instead,
    // and prove no second transferToken happens.
    const api = new StubApi();
    const payer = new StubPayer();
    const wallet = makeSourceWallet(fixture.payChainId);
    const { provider, runtime, context } = buildRuntime(api, payer, wallet);
    const orderId = `${fixture.orderId}:route-mismatch`;
    const baseInput = { ...payOrderInput, orderId };
    let transferCount = 0;
    payer.transferToken = async (transferInput: { tokenAddress: string; to: string; amount: string }) => {
      transferCount += 1;
      payer.transferred = transferInput;
      return { txHash: `0xroute_${transferCount}` };
    };

    const first = await runtime.run(provider.get('goat.gns.x402.payOrder'), context, baseInput, { confirmed: true });
    expect(first.ok).toBe(true);
    expect(first.output!.txHash).toBe('0xroute_1');

    // Second call: same orderId, different amountWei. Cache key mismatch
    // must surface as INVALID_INPUT and must NOT broadcast.
    const mutated = { ...baseInput, amountWei: (BigInt(baseInput.amountWei) * 2n).toString() };
    const second = await runtime.run(provider.get('goat.gns.x402.payOrder'), context, mutated, { confirmed: true });
    expect(second.ok).toBe(false);
    expect(second.errorCode).toBe('INVALID_INPUT');
    expect(second.error).toMatch(/order_already_paid/);
    expect(second.error).toMatch(/different payment routing/);
    expect(transferCount, 'route-mismatch retry must not broadcast another transfer').toBe(1);
  });

  it('submitSignature surfaces ADAPTER_REQUEST_FAILED when gateway reports failed', async () => {
    const api = new StubApi();
    api.submitOutcome = 'failed';
    const payer = new StubPayer();
    const wallet = makeSourceWallet(fixture.payChainId);
    const { provider, runtime, context } = buildRuntime(api, payer, wallet);
    const res = await runtime.run(
      provider.get('goat.gns.x402.submitSignature'),
      context,
      {
        orderId: fixture.orderId,
        calldataSignRequest: fixture.calldataSignRequest,
      },
      { confirmed: true },
    );
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('ADAPTER_REQUEST_FAILED');
  });
});
