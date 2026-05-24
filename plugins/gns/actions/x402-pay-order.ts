import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import { AgentkitRuntimeError } from '../../../core/errors/error';
import { ErrorCodes } from '../../../core/errors/error-codes';
import { evmAddress } from '../../../core/schema/validators';
import type { PayerWalletAdapter } from '../../x402/adapters/types';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import type { GnsApiAdapter } from '../adapters/types';
import { EXPIRY_SAFETY_MARGIN_SEC } from '../constants';

/**
 * EIP-712 typed-data shape returned by `createOrder.calldataSignRequest`.
 * The backend pre-signs this so the agent only signs the typed data the
 * adaptor's on-chain verifier will accept. We require it as a payOrder
 * input so the action can cross-check the merchant's claimed payment
 * routing against this signed authorization (defense in depth — Issue #3
 * Round 2 Codex P1).
 */
const calldataSignRequestSchema = z
  .object({
    domain: z.record(z.unknown()),
    types: z.record(z.array(z.object({ name: z.string(), type: z.string() }))),
    primaryType: z.string().min(1),
    message: z.record(z.unknown()),
  })
  .passthrough();

/**
 * Input now carries payment routing fields from the `createOrder` response.
 *
 * RATIONALE (Issue #3 — Round 1 verified by Claude + Codex): the GNS x402
 * status endpoint (`/payments/x402/orders/{id}`) returns a lifecycle
 * projection only (`OrderProof` in `goat-ens/backend/lib/goatx402-sdk-server/
 * src/types.ts:111-123`). It carries `status`, `chainId`, `fromAddress`,
 * `amountWei`, and an adaptor-side `tokenContract` — but it does NOT carry
 * `payToAddress`, `expiresAt`, or the source-chain `tokenContract` needed to
 * actually broadcast the ERC-20 transfer. Those live in the `createOrder`
 * response (`Order` shape, `types.ts:44-67`) and are the authoritative
 * source-of-truth (confirmed by the production frontend at
 * `goat-ens/frontend/src/app/register/hooks/crossChainRegistrationSubmissionFlow.ts`,
 * which threads `pendingOrder.payToAddress` / `pendingOrder.tokenContract` /
 * `pendingOrder.expiresAt` through the flow, never re-fetching them).
 *
 * The status endpoint is used ONLY as a lifecycle gate (is the order still
 * pre-payment vs already-paid / expired / cancelled).
 */
const inputSchema = z.object({
  orderId: z.string().min(1),
  /** Source-chain numeric id (e.g. 56 for BSC). From `createOrder.payChainId`. */
  payChainId: z.number().int().positive(),
  /** Source-chain ERC-20 contract the agent must transferFrom. NOT the GOAT-side adaptor token. From `createOrder.tokenContract`. */
  tokenContract: evmAddress,
  /** Recipient address on the source chain. From `createOrder.payToAddress`. */
  payToAddress: evmAddress,
  /** Amount in source-chain token wei (base-10 integer string). From `createOrder.amountWei`. */
  amountWei: z.string().regex(/^\d+$/, 'amountWei must be a base-10 integer string'),
  /** Order expiry (Unix seconds). From `createOrder.expiresAt`. Refusing to pay inside the safety margin avoids losing funds to an order that expires mid-broadcast. */
  expiresAt: z.number().int().positive(),
  /**
   * Backend-issued EIP-712 typed data (from `createOrder.calldataSignRequest`).
   * Threaded into payOrder so the action can cross-check the merchant's
   * declared payment receiver (`message.owner`) and payer (`message.payer`)
   * against the caller-supplied `payToAddress` + wallet address. Without
   * this, a caller with a valid orderId could redirect the transfer
   * destination by lying about `payToAddress` (Issue #3 Round 2 Codex P1).
   * The adaptor on-chain verifies the signature on this calldata, so a
   * forged calldataSignRequest would also fail the upstream callback —
   * this check fails fast inside the SDK before any funds move.
   */
  calldataSignRequest: calldataSignRequestSchema,
});

export type X402PayOrderInput = z.infer<typeof inputSchema>;

export interface X402PayOrderOutput {
  orderId: string;
  txHash: string;
  payChainId: number;
  amountWei: string;
}

const outputSchema: z.ZodType<X402PayOrderOutput> = z.object({
  orderId: z.string(),
  txHash: z.string(),
  payChainId: z.number(),
  amountWei: z.string(),
});

/**
 * Per-orderId single-flight against double-pay under concurrency. The status
 * gate inside is TOCTOU — without this Map two concurrent calls for the same
 * orderId could both observe a payable state and both broadcast the transfer
 * (a money-path bug). Sequential retries after the first completes hit the
 * status gate, which by then reflects the post-pay state.
 */
const inflight = new Map<string, Promise<X402PayOrderOutput>>();

/**
 * SECURITY MODEL — what this action defends against vs what it cannot
 * =====================================================================
 *
 * **Defends against (SDK-side fail-fast layer)**:
 *
 *   1. Status-endpoint mismatch — input.payChainId / amountWei / wallet
 *      address vs `OrderProof.{chainId, amountWei, fromAddress}`.
 *   2. Signed-calldata mismatch — input.payToAddress vs
 *      `calldataSignRequest.message.owner`; payer-signer address vs
 *      `message.payer`. `message.owner` is REQUIRED (fail-closed if absent).
 *   3. Token substitution — input.tokenContract vs the merchant's
 *      authoritative x402Config supported-token list for the source chain.
 *      Missing chain in config → fail-closed `INVALID_INPUT`.
 *   4. Double-pay TOCTOU — module-scope inflight Map dedupes concurrent
 *      calls for the same orderId.
 *   5. Expiry window — refuse if `now ≥ expiresAt - EXPIRY_SAFETY_MARGIN`.
 *
 * **What this action cannot prevent (architectural — Issue #3 R4 Codex P1)**:
 *
 *   A malicious orchestrator that wraps the SDK and CONTROLS BOTH the
 *   inputs (orderId + payToAddress + calldataSignRequest) can pass the
 *   above gates by ensuring its forged inputs are internally consistent.
 *   Specifically, an orchestrator could:
 *     - present a `payToAddress` equal to attacker_addr
 *     - forge a `calldataSignRequest.message.owner` to also equal attacker_addr
 *     - pass all SDK gates
 *
 *   Real-world impact: the orchestrator broadcasts a transfer from its
 *   own wallet TO its own address — a self-transfer. The backend's
 *   chain-watcher never sees a payment to the real merchant, so the order
 *   never transitions PAYMENT_CONFIRMED → INVOICED and the `.goat` name
 *   is not registered. The orchestrator has paid itself for nothing.
 *
 *   This is "buggy orchestrator hurts itself", NOT "attacker drains a
 *   third party's funds". The full mitigation requires the GNS backend to
 *   expose canonical `payToAddress` + source-chain `tokenContract` in the
 *   status-endpoint `OrderProof`; until that exists the SDK can only
 *   verify against the caller-supplied calldata.
 *
 *   For multi-tenant orchestrators, the recommended pattern is to call
 *   `createOrder + submitSignature + payOrder` as a single atomic unit
 *   with no external mutation between steps, and to derive ALL routing
 *   fields from the `createOrder` response unchanged.
 *
 * `goat.gns.x402.payOrder` — broadcast the source-chain ERC-20 transfer that
 * fulfills an authorized x402 register order.
 *
 * The upstream GoatX402 service watches the source chain for this transfer
 * and auto-transitions the order: `CHECKOUT_VERIFIED → PAYMENT_CONFIRMED`
 * (transfer landed) → `INVOICED` (adaptor callback executed on GOAT —
 * registration finalised). The agent's job ends at "transfer broadcast";
 * subsequent state machine transitions are watcher-driven.
 *
 * Adapter pattern: `payer` MUST be a `PayerWalletAdapter` bound to the
 * SOURCE chain (Base, Polygon, BSC, …), NOT the GOAT-bound one used for
 * `submitSignature`. Construct two adapter instances:
 *
 *   ```ts
 *   const goatPayerAdapter   = new EvmPayerWalletAdapter(goatSigner);   // submitSignature
 *   const sourcePayerAdapter = new EvmPayerWalletAdapter(sourceSigner); // payOrder
 *   ```
 *
 * `wallet` here is the source-chain `WalletProvider` used purely for chain-id
 * validation (`wallet.getChainId() === input.payChainId`); the actual ERC-20
 * transfer goes through `payer.transferToken(...)`.
 *
 * Pre-flight checks:
 *  - `wallet.getChainId()` and `payer.getChainId()` (if implemented) both
 *    match `input.payChainId`, else `INVALID_INPUT`.
 *  - `nowSec < input.expiresAt - EXPIRY_SAFETY_MARGIN_SEC`, else `INVALID_INPUT`.
 *  - Status fetch returns `CHECKOUT_VERIFIED`, else `INVALID_INPUT` —
 *    `PAYMENT_CONFIRMED` / `INVOICED` mean already paid (refuse to double-pay);
 *    `FAILED` / `EXPIRED` / `CANCELLED` mean the order is dead; any other
 *    value (including missing) is treated as a not-yet-payable signal and
 *    surfaced as a typed error so the caller can decide whether to retry.
 *
 * `networks: []` (wildcard) — runtime PolicyEngine still gates per
 * `allowedNetworks`.
 */
export function x402PayOrderAction(
  api: GnsApiAdapter,
  payer: PayerWalletAdapter,
  wallet: WalletProvider,
): ActionDefinition<X402PayOrderInput, X402PayOrderOutput> {
  return {
    name: 'goat.gns.x402.payOrder',
    description: 'Pay the source-chain ERC-20 transfer that funds an authorized x402 register order',
    riskLevel: 'high',
    requiresConfirmation: true,
    networks: [],
    zodInputSchema: inputSchema,
    zodOutputSchema: outputSchema,
    async execute(ctx, input) {
      const existing = inflight.get(input.orderId);
      if (existing) return existing;
      const promise = (async (): Promise<X402PayOrderOutput> => {
        // Chain bindings BEFORE the status round-trip so a misconfigured
        // wallet can't waste an extra network call and so the chain-mismatch
        // error is reported in clean isolation.
        if (typeof wallet.getChainId !== 'function') {
          throw new AgentkitRuntimeError(
            ErrorCodes.INVALID_INPUT,
            'wallet does not implement getChainId(); cross-chain x402 payOrder requires it to enforce chain binding',
          );
        }
        const walletChainId = await wallet.getChainId();
        if (walletChainId !== input.payChainId) {
          throw new AgentkitRuntimeError(
            ErrorCodes.INVALID_INPUT,
            `chain_mismatch: wallet on chain ${walletChainId}, order requires ${input.payChainId}; switch the source-chain WalletProvider before retrying`,
          );
        }
        if (typeof payer.getChainId === 'function') {
          const payerChainId = await payer.getChainId();
          if (payerChainId !== input.payChainId) {
            throw new AgentkitRuntimeError(
              ErrorCodes.INVALID_INPUT,
              `chain_mismatch: payer on chain ${payerChainId}, order requires ${input.payChainId}; payer and wallet must both target the source chain`,
            );
          }
        }

        const nowSec = Math.floor(Date.now() / 1000);
        if (nowSec >= input.expiresAt - EXPIRY_SAFETY_MARGIN_SEC) {
          throw new AgentkitRuntimeError(
            ErrorCodes.INVALID_INPUT,
            `order_not_payable: within ${EXPIRY_SAFETY_MARGIN_SEC}s expiry margin (now=${nowSec}, expiresAt=${input.expiresAt}); re-issue the order to extend the window`,
          );
        }

        // Lifecycle gate — fetch the status projection to confirm the
        // order is still in the pre-payment terminal state CHECKOUT_VERIFIED.
        // FAIL CLOSED: explicit equality required (not `!== 'PAID'`-style)
        // because `X402OrderLifecycle` widens to `string` so an empty /
        // unexpected value would otherwise slip past a negated check and
        // re-broadcast the transfer.
        //
        // Backend enum (authoritative — goat-ens backend
        // lib/goatx402-sdk-server/src/types.ts:69-76):
        //   'CHECKOUT_VERIFIED' | 'PAYMENT_CONFIRMED' | 'INVOICED'
        //   | 'FAILED' | 'EXPIRED' | 'CANCELLED'
        // No 'PAYMENT_PENDING' — older SDK builds checked for that value,
        // which the backend NEVER emits (this is what Issue #3 fixed).
        const order = await api.getX402Order(input.orderId, ctx.signal);
        if (order.status !== 'CHECKOUT_VERIFIED') {
          throw new AgentkitRuntimeError(
            ErrorCodes.INVALID_INPUT,
            `order_not_payable: status=${order.status ?? '<missing>'} (expected CHECKOUT_VERIFIED; refuse to double-pay or pay a dead order)`,
          );
        }

        // Defense in depth (Issue #3 Round 1 Codex P1 + Round 2 Codex P1):
        // bind every caller-supplied payment routing field to a trusted
        // source. Without these checks, a bad / stale caller with a valid
        // orderId could redirect funds to an attacker-controlled address or
        // substitute a different ERC-20 token.
        //
        // Trust sources:
        //   1. Status endpoint `OrderProof` (raw):
        //        chainId, amountWei, fromAddress
        //   2. createOrder's calldataSignRequest message (caller-passed but
        //      cryptographically anchored — the adaptor on-chain verifier
        //      checks the signature, so a tampered calldata fails the
        //      eventual callback even if the SDK accepted it):
        //        message.owner    → input.payToAddress
        //        message.payer    → wallet address
        //   3. Merchant x402Config (canonical source-chain tokens per chain):
        //        chains[input.payChainId].tokens[].contract
        //          → must include input.tokenContract
        const raw = (order.raw ?? {}) as Record<string, unknown>;

        // STRICT: require `message.owner` and `message.payer` (both EVM
        // addresses) to be present in the signed calldata. The fix's threat
        // model assumes a caller could try to redirect funds by lying about
        // `payToAddress`; the calldata's `owner` field is the cryptographic
        // anchor (the on-chain adaptor verifies the signature over this typed
        // data). Older Eip3009CallbackData shapes lacked `owner`, so we
        // would have skipped the check — which Issue #3 R3 (Claude + Codex
        // consensus) identified as a money-path bypass. Production now
        // emits Permit2CallbackData with `owner`; we fail closed for any
        // shape that doesn't carry it.
        const message = (input.calldataSignRequest.message ?? {}) as Record<string, unknown>;
        const messageOwner = message.owner;
        if (typeof messageOwner !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(messageOwner)) {
          throw new AgentkitRuntimeError(
            ErrorCodes.INVALID_INPUT,
            `order_proof_mismatch: calldataSignRequest.message.owner is missing or not an EVM address — cannot cryptographically bind input.payToAddress to a backend-signed receiver, refuse to broadcast`,
          );
        }
        if (messageOwner.toLowerCase() !== input.payToAddress.toLowerCase()) {
          throw new AgentkitRuntimeError(
            ErrorCodes.INVALID_INPUT,
            `order_proof_mismatch: input.payToAddress=${input.payToAddress} but calldataSignRequest.message.owner=${messageOwner} — caller cannot redirect the merchant's payment-receive address`,
          );
        }
        const messagePayer = message.payer;
        if (typeof messagePayer !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(messagePayer)) {
          throw new AgentkitRuntimeError(
            ErrorCodes.INVALID_INPUT,
            `order_proof_mismatch: calldataSignRequest.message.payer is missing or not an EVM address — cannot bind to the broadcasting wallet, refuse to broadcast`,
          );
        }
        const walletAddr = (await wallet.getAddress()).toLowerCase();
        const messagePayerNorm = messagePayer.toLowerCase();
        // 3-way payer binding (Issue #3 R4 Codex P5 + R6 Claude logic-flaw):
        // require all three addresses to agree —
        //   (a) wallet (chain-validated above)
        //   (b) payer adapter signer (the key that actually broadcasts the
        //       ERC-20 transfer, via payer.transferToken)
        //   (c) message.payer (the signed authorization in calldata)
        //
        // We encode this as TWO checks (wallet ≡ message.payer; wallet ≡
        // payer.getAddress when present) — by transitivity payer ≡
        // message.payer is automatically enforced. An earlier R5 version
        // added a third explicit `payerAddr !== messagePayer` check, which
        // R6 Claude correctly identified as unreachable dead code: any
        // input that could trigger it is already caught by the wallet ≡
        // message.payer check (since payerAddr === walletAddr by that
        // point). The 2-check form is the minimum-sufficient logic with
        // the same security invariant and no dead branches.
        if (messagePayerNorm !== walletAddr) {
          throw new AgentkitRuntimeError(
            ErrorCodes.INVALID_INPUT,
            `order_proof_mismatch: calldataSignRequest.message.payer=${messagePayer} but configured wallet=${walletAddr} — the broadcasting wallet does not match the signed payer authorization`,
          );
        }
        if (typeof payer.getAddress === 'function') {
          const payerAddr = (await payer.getAddress()).toLowerCase();
          if (payerAddr !== walletAddr) {
            throw new AgentkitRuntimeError(
              ErrorCodes.INVALID_INPUT,
              `chain_mismatch: payer signer address=${payerAddr} does not match wallet address=${walletAddr} — the broadcasting payer signer is wired to a different key than the configured wallet (and therefore also differs from the signed message.payer=${messagePayer})`,
            );
          }
        }

        // x402Config tokenContract guard. The status proof's `tokenContract`
        // is the GOAT-side adaptor token (a different address than the
        // source-chain ERC-20), so we cross-check `input.tokenContract`
        // against the merchant's authoritative supported-token list for
        // `input.payChainId`. A token swap by a malicious caller would fail
        // this lookup. If x402Config is unreachable we surface
        // ADAPTER_REQUEST_FAILED so the caller knows defense is degraded.
        //
        // STRICT (Issue #3 R3 — Codex P2): also fail closed when the chain
        // is missing from the merchant config, or the chain has no tokens
        // array. Previous behaviour degraded to "accept" on missing chain,
        // which silently disabled the defense if the local config cache
        // drifted from the upstream merchant config.
        try {
          const cfg = await api.x402Config(ctx.signal);
          if (!Array.isArray(cfg?.chains)) {
            throw new AgentkitRuntimeError(
              ErrorCodes.ADAPTER_REQUEST_FAILED,
              `x402Config returned no chains array — merchant config malformed; refuse to transfer without authoritative token list`,
            );
          }
          const chainCfg = cfg.chains.find((c) => c.chainId === input.payChainId);
          if (!chainCfg) {
            const known = cfg.chains.map((c) => `${c.name}(${c.chainId})`).join(', ') || 'none';
            throw new AgentkitRuntimeError(
              ErrorCodes.INVALID_INPUT,
              `order_proof_mismatch: input.payChainId=${input.payChainId} is not in the merchant's x402Config (supported: ${known}) — refuse to transfer for an unrecognised chain`,
            );
          }
          if (!Array.isArray(chainCfg.tokens) || chainCfg.tokens.length === 0) {
            throw new AgentkitRuntimeError(
              ErrorCodes.ADAPTER_REQUEST_FAILED,
              `x402Config has no tokens for chain ${input.payChainId} — merchant config malformed`,
            );
          }
          const wantAddr = input.tokenContract.toLowerCase();
          const match = chainCfg.tokens.find((t) => t.contract.toLowerCase() === wantAddr);
          if (!match) {
            const known = chainCfg.tokens.map((t) => `${t.symbol}=${t.contract}`).join(', ') || 'none';
            throw new AgentkitRuntimeError(
              ErrorCodes.INVALID_INPUT,
              `order_proof_mismatch: input.tokenContract=${input.tokenContract} is not in the merchant's supported tokens for chain ${input.payChainId} (supported: ${known}) — refuse to transfer an unrecognised token`,
            );
          }
        } catch (err) {
          // Propagate AgentkitRuntimeError (typed throws above);
          // wrap anything else as ADAPTER_REQUEST_FAILED so the caller
          // doesn't silently lose the defense check.
          if (err instanceof AgentkitRuntimeError) throw err;
          throw new AgentkitRuntimeError(
            ErrorCodes.ADAPTER_REQUEST_FAILED,
            `x402Config preflight failed in payOrder: ${(err as Error).message ?? String(err)}`,
          );
        }
        // FAIL-CLOSED proof-binding (Issue #3 F2): the backend's `OrderProof`
        // shape (goat-ens/backend/lib/goatx402-sdk-server/src/types.ts:111-123)
        // guarantees `chainId`, `amountWei`, and `fromAddress` are always
        // present. An earlier version silently skipped each check when the
        // field was absent or the wrong type, which is fail-open — a
        // malformed upstream response would let the transfer proceed
        // unbound. Now each field is strictly required: malformed/missing →
        // ADAPTER_REQUEST_FAILED (caller knows defense is unverifiable),
        // mismatch → INVALID_INPUT (caller knows the inputs disagree).
        const proofChainIdRaw = raw.payChainId ?? raw.chainId;
        if (proofChainIdRaw === undefined || proofChainIdRaw === null) {
          throw new AgentkitRuntimeError(
            ErrorCodes.ADAPTER_REQUEST_FAILED,
            `order_proof_malformed: status response missing payChainId/chainId (orderId=${input.orderId}) — cannot bind input.payChainId to a trusted source`,
            { raw },
          );
        }
        // F2 + Round 1 Codex P1: STRICT type — backend `OrderProof.chainId`
        // is typed as `number` (goat-ens backend types.ts:111-123). Accepting
        // string-coerced numerics via `Number(...)` defeats the
        // wrong-type → ADAPTER_REQUEST_FAILED contract that F2 was meant to
        // enforce. If the backend ever emits a string here, that's a real
        // malformed response and the caller should be told.
        if (typeof proofChainIdRaw !== 'number' || !Number.isInteger(proofChainIdRaw) || proofChainIdRaw <= 0) {
          // Use String(...) not JSON.stringify(...) — JSON.stringify throws
          // TypeError on BigInt, which would shadow the typed
          // ADAPTER_REQUEST_FAILED error with a plain TypeError (R2 Codex P2).
          throw new AgentkitRuntimeError(
            ErrorCodes.ADAPTER_REQUEST_FAILED,
            `order_proof_malformed: status response payChainId/chainId is not a positive integer (orderId=${input.orderId}, value=${String(proofChainIdRaw)}, typeof=${typeof proofChainIdRaw})`,
            { raw },
          );
        }
        if (proofChainIdRaw !== input.payChainId) {
          throw new AgentkitRuntimeError(
            ErrorCodes.INVALID_INPUT,
            `order_proof_mismatch: input.payChainId=${input.payChainId} but on-record order.chainId=${proofChainIdRaw} — caller passed routing for a different chain`,
          );
        }
        if (typeof raw.amountWei !== 'string' || !/^\d+$/.test(raw.amountWei)) {
          throw new AgentkitRuntimeError(
            ErrorCodes.ADAPTER_REQUEST_FAILED,
            `order_proof_malformed: status response amountWei is missing or not a base-10 integer string (orderId=${input.orderId}, value=${String(raw.amountWei)}, typeof=${typeof raw.amountWei})`,
            { raw },
          );
        }
        if (raw.amountWei !== input.amountWei) {
          throw new AgentkitRuntimeError(
            ErrorCodes.INVALID_INPUT,
            `order_proof_mismatch: input.amountWei=${input.amountWei} but on-record order.amountWei=${raw.amountWei} — caller passed a different amount than the order was created with`,
          );
        }
        if (typeof raw.fromAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(raw.fromAddress)) {
          throw new AgentkitRuntimeError(
            ErrorCodes.ADAPTER_REQUEST_FAILED,
            `order_proof_malformed: status response fromAddress is missing or not an EVM address (orderId=${input.orderId}, value=${String(raw.fromAddress)}, typeof=${typeof raw.fromAddress})`,
            { raw },
          );
        }
        // Reuse `walletAddr` resolved during the message.payer check above —
        // avoids a second async getAddress() round-trip (R5 Claude P2).
        if (raw.fromAddress.toLowerCase() !== walletAddr) {
          throw new AgentkitRuntimeError(
            ErrorCodes.INVALID_INPUT,
            `order_proof_mismatch: order.fromAddress=${raw.fromAddress} but configured wallet address=${walletAddr} — the broadcasting wallet does not match the recorded payer`,
          );
        }

        const { txHash } = await payer.transferToken(
          { tokenAddress: input.tokenContract, to: input.payToAddress, amount: input.amountWei },
          ctx.signal,
        );

        return {
          orderId: input.orderId,
          txHash,
          payChainId: input.payChainId,
          amountWei: input.amountWei,
        };
      })().finally(() => {
        inflight.delete(input.orderId);
      });
      inflight.set(input.orderId, promise);
      return promise;
    },
  };
}
