import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import { AgentkitRuntimeError } from '../../../core/errors/error';
import { ErrorCodes } from '../../../core/errors/error-codes';
import type { PayerWalletAdapter } from '../../x402/adapters/types';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import type { GnsApiAdapter } from '../adapters/types';
import { EXPIRY_SAFETY_MARGIN_SEC } from '../constants';

const inputSchema = z.object({
  orderId: z.string().min(1),
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
 * `goat.gns.x402.payOrder` — actually pay the source-chain ERC-20 transfer
 * that backs the x402 callback signature.
 *
 * This step is what Codex R2 #13 surfaced: after `submitSignature` returns
 * `'authorized'` the agent has only signed the EIP-712 typed data; the
 * source-chain ERC-20 transfer hasn't happened yet. Without this action the
 * order would expire unfunded.
 *
 * Adapter pattern (Codex R3 #A): the `payer` here MUST be a
 * `PayerWalletAdapter` bound to the SOURCE chain (Base, Polygon, …), NOT
 * the GOAT-bound one used for `submitSignature`. Construct two adapter
 * instances:
 *
 *   ```ts
 *   const goatPayerAdapter   = new EvmPayerWalletAdapter(goatSigner);   // submitSignature
 *   const sourcePayerAdapter = new EvmPayerWalletAdapter(sourceSigner); // payOrder
 *   ```
 *
 * `wallet` here is the source-chain `WalletProvider` used purely for chain-id
 * validation (`await wallet.getChainId() === order.payChainId`); the actual
 * ERC-20 transfer goes through `payer.transferToken(...)`.
 *
 * Pre-flight checks:
 *  - `wallet.getChainId() === order.payChainId` (else `INVALID_INPUT`).
 *  - `Date.now()/1000 < order.expiresAt - 30s` safety margin (else
 *    `INVALID_INPUT('order_not_payable: within 30s expiry margin')`).
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
      const order = await api.getX402Order(input.orderId, ctx.signal);

      // Status gate — never re-pay a non-pending order. Backends that
      // surface a lifecycle string under `order.status` must be in
      // `PAYMENT_PENDING` for us to broadcast the source-chain transfer.
      if (order.status && order.status !== 'PAYMENT_PENDING') {
        throw new AgentkitRuntimeError(
          ErrorCodes.INVALID_INPUT,
          `order_not_payable: status=${order.status} (expected PAYMENT_PENDING; refuse to double-pay)`,
        );
      }

      // Per Codex R6 #14: enforce a strict runtime shape on `order.raw`
      // before any chain write. The status endpoint is loosely typed,
      // so each field is parsed with Zod and a missing/malformed field
      // surfaces as ADAPTER_REQUEST_FAILED with the specific field name.
      const rawPaymentSchema = z.object({
        payChainId: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]).optional(),
        chainId: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]).optional(),
        amountWei: z.string().regex(/^\d+$/),
        payToAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        tokenContract: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        expiresAt: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
      });
      const parsed = rawPaymentSchema.safeParse(order.raw ?? {});
      if (!parsed.success) {
        throw new AgentkitRuntimeError(
          ErrorCodes.ADAPTER_REQUEST_FAILED,
          `x402 order status missing or malformed required fields (orderId=${input.orderId}): ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
          { raw: order.raw },
        );
      }
      const payChainIdRaw = parsed.data.payChainId ?? parsed.data.chainId;
      if (payChainIdRaw == null) {
        throw new AgentkitRuntimeError(
          ErrorCodes.ADAPTER_REQUEST_FAILED,
          `x402 order status missing required field: payChainId / chainId (orderId=${input.orderId})`,
          { raw: order.raw },
        );
      }
      const payChainId = Number(payChainIdRaw);
      const amountWei = parsed.data.amountWei;
      const payToAddress = parsed.data.payToAddress;
      const tokenContract = parsed.data.tokenContract;
      const expiresAt = Number(parsed.data.expiresAt);

      const nowSec = Math.floor(Date.now() / 1000);
      if (nowSec >= expiresAt - EXPIRY_SAFETY_MARGIN_SEC) {
        throw new AgentkitRuntimeError(
          ErrorCodes.INVALID_INPUT,
          `order_not_payable: within ${EXPIRY_SAFETY_MARGIN_SEC}s expiry margin (now=${nowSec}, expiresAt=${expiresAt})`,
        );
      }

      if (typeof wallet.getChainId !== 'function') {
        throw new AgentkitRuntimeError(
          ErrorCodes.INVALID_INPUT,
          'wallet does not implement getChainId(); cross-chain x402 payOrder requires it to enforce chain binding',
        );
      }
      const walletChainId = await wallet.getChainId();
      if (walletChainId !== payChainId) {
        throw new AgentkitRuntimeError(
          ErrorCodes.INVALID_INPUT,
          `chain_mismatch: wallet on chain ${walletChainId}, order requires ${payChainId}; switch the source-chain WalletProvider before retrying`,
        );
      }

      const { txHash } = await payer.transferToken(
        { tokenAddress: tokenContract, to: payToAddress, amount: amountWei },
        ctx.signal,
      );

      return { orderId: input.orderId, txHash, payChainId, amountWei };
    },
  };
}
