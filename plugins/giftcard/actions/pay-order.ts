import { z } from 'zod';
import { AgentkitRuntimeError } from '../../../core/errors/error';
import { ErrorCodes } from '../../../core/errors/error-codes';
import { getChainMetadata } from '../../../networks/evm/chains';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import type { GiftcardGateway } from '../adapters/types';

export interface PayOrderInput {
  orderId: string;
}

export interface PayOrderOutput {
  txHash: string;
  orderId: string;
  payChainId: number;
  payAmountWei: string;
}

const inputSchema = z
  .object({
    orderId: z.string().uuid({ message: 'orderId must be a UUID' }),
  })
  .strict();

const outputSchema = z.object({
  txHash: z.string(),
  orderId: z.string(),
  payChainId: z.number().int(),
  payAmountWei: z.string().regex(/^\d+$/),
});

type GatewaySlice = Pick<GiftcardGateway, 'getOrder'>;
/**
 * `getChainId` is optional on `WalletProvider` (added in 0.2.x for
 * backwards compatibility with third-party impls), but the chain-bind
 * check below is non-negotiable, so the slice the action receives MUST
 * supply it. Built-in providers all do; custom providers that fail to
 * implement it will surface as a clear `INVALID_INPUT` at runtime.
 */
type WalletSlice = Pick<WalletProvider, 'transferErc20'> & {
  getChainId(): Promise<number>;
};

/** Safety margin before order expiry below which we refuse to pay. */
const EXPIRY_SAFETY_MARGIN_SECONDS = 30;

/**
 * Per-orderId single-flight: collapses concurrent payOrder calls for the
 * same orderId into one execution. The status-only gate at step (1) is
 * TOCTOU under concurrency — two callers can both observe PAYMENT_PENDING
 * before either transfer settles, and both would then broadcast the
 * ERC-20 transfer (double-pay). The Map below holds the in-flight
 * promise so concurrent callers reuse the same execution; subsequent
 * (sequential) retries hit the status gate which by then reflects the
 * post-pay state. Process-local only — multi-process exclusion still
 * requires backend idempotency, but this closes the in-process race
 * that the runtime cache misses when callers omit `idempotencyKey`.
 */
const inflight = new Map<string, Promise<PayOrderOutput>>();

/**
 * `goat.giftcard.payOrder` — executes the ERC-20 transfer that pays
 * for a previously-created order.
 *
 * Validation order (strictly ordered to fail-fast cheaply):
 *   1. Fetch the order — backend is authoritative for pay amount,
 *      pay-to address, chain id, token contract, expiry.
 *   2. Validate `pay_amount_wei` is `\d+` BEFORE `BigInt()` coercion
 *      (Claude P1 #10). Backend should always emit a decimal-only
 *      string, but a defensive regex prevents `SyntaxError` getting
 *      surfaced as INTERNAL_ERROR.
 *   3. Expiry safety margin: `now < expire_at - 30s`. Avoids a race
 *      where a confirmed transfer hits a backend that has already
 *      auto-expired the order (Codex #5).
 *   4. Chain match: `wallet.getChainId() === order.pay_chain_id`.
 *      Human-readable mismatch error uses `getChainMetadata()` for
 *      display names.
 *
 * Only after all four pass do we touch the wallet.
 *
 * `networks` is the explicit cross-chain allowlist — wallets on chains
 * not in this set should never reach `execute` because the policy
 * engine gates the runtime network.
 */
export function payOrderAction(
  gateway: GatewaySlice,
  wallet: WalletSlice,
): ActionDefinition<PayOrderInput, PayOrderOutput> {
  return {
    name: 'goat.giftcard.payOrder',
    description:
      'Pay a previously-created giftcard order by executing the ERC-20 transfer on the order-prescribed chain.',
    riskLevel: 'high',
    requiresConfirmation: true,
    networks: [
      'goat-mainnet',
      'goat-testnet',
      'ethereum-mainnet',
      'polygon-mainnet',
      'arbitrum-mainnet',
      'base-mainnet',
      'optimism-mainnet',
      'bsc-mainnet',
      'metis-mainnet',
    ],
    zodInputSchema: inputSchema,
    zodOutputSchema: outputSchema,
    async execute(ctx, input) {
      const existing = inflight.get(input.orderId);
      if (existing) return existing;
      const promise = (async (): Promise<PayOrderOutput> => {
      const order = await gateway.getOrder(input.orderId, ctx.signal);

      // (1) Status gate — never re-pay a non-pending order. Without this
      //     a retry path against a FULFILLED / PAYMENT_CONFIRMED order
      //     would re-send the ERC-20 transfer.
      if (order.status !== 'PAYMENT_PENDING') {
        throw new AgentkitRuntimeError(
          ErrorCodes.INVALID_INPUT,
          `order_not_payable: status=${order.status} (expected PAYMENT_PENDING; refuse to double-pay)`,
        );
      }

      // (2) Validate pay_amount_wei format.
      const payAmountWei = order.pay_amount_wei;
      if (typeof payAmountWei !== 'string' || !/^\d+$/.test(payAmountWei)) {
        throw new AgentkitRuntimeError(
          ErrorCodes.INVALID_INPUT,
          `order_invalid: pay_amount_wei missing or non-numeric (got: ${String(payAmountWei)})`,
        );
      }

      const payToAddress = order.pay_to_address;
      if (!payToAddress) {
        throw new AgentkitRuntimeError(
          ErrorCodes.INVALID_INPUT,
          'order_invalid: pay_to_address is missing — order not in PAYMENT_PENDING state?',
        );
      }

      const payTokenContract = order.pay_token_contract;
      if (!payTokenContract) {
        throw new AgentkitRuntimeError(
          ErrorCodes.INVALID_INPUT,
          'order_invalid: pay_token_contract is missing — order not in PAYMENT_PENDING state?',
        );
      }

      if (!order.expire_at) {
        throw new AgentkitRuntimeError(
          ErrorCodes.INVALID_INPUT,
          'order_invalid: expire_at is missing',
        );
      }

      // (3) Expiry safety margin.
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (nowSeconds >= order.expire_at - EXPIRY_SAFETY_MARGIN_SECONDS) {
        throw new AgentkitRuntimeError(
          ErrorCodes.INVALID_INPUT,
          `order_not_payable: within ${EXPIRY_SAFETY_MARGIN_SECONDS}s expiry margin (now=${nowSeconds}, expire_at=${order.expire_at})`,
        );
      }

      // (4) Chain match.
      const walletChainId = await wallet.getChainId();
      if (walletChainId !== order.pay_chain_id) {
        const walletMeta = getChainMetadata(walletChainId);
        const orderMeta = getChainMetadata(order.pay_chain_id);
        throw new AgentkitRuntimeError(
          ErrorCodes.INVALID_INPUT,
          `chain_mismatch: wallet on chain ${walletChainId} (${walletMeta.displayName}), order requires ${order.pay_chain_id} (${orderMeta.displayName})`,
        );
      }

      const { txHash } = await wallet.transferErc20(payTokenContract, payToAddress, payAmountWei, {
        signal: ctx.signal,
      });

      return {
        txHash,
        orderId: input.orderId,
        payChainId: order.pay_chain_id,
        payAmountWei,
      };
      })().finally(() => {
        inflight.delete(input.orderId);
      });
      inflight.set(input.orderId, promise);
      return promise;
    },
  };
}
