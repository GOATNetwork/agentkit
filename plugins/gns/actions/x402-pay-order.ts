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

      // We need amountWei/tokenContract/payToAddress/expiresAt/payChainId.
      // The status endpoint may return them or may not — production includes
      // them in `raw`. Re-fetch via createX402Order? No — we don't have the
      // creation inputs. We rely on the status endpoint exposing them in
      // `raw` and fall back to AgentkitRuntimeError if missing.
      const raw = (order.raw ?? {}) as Record<string, unknown>;
      const payChainId = Number(raw.payChainId ?? raw.chainId ?? 0);
      const amountWei = String(raw.amountWei ?? '');
      const payToAddress = String(raw.payToAddress ?? '');
      const tokenContract = String(raw.tokenContract ?? '');
      const expiresAt = Number(raw.expiresAt ?? 0);
      if (!payChainId || !amountWei || !payToAddress || !tokenContract) {
        throw new AgentkitRuntimeError(
          ErrorCodes.ADAPTER_REQUEST_FAILED,
          `x402 order status missing required fields for payment (orderId=${input.orderId})`,
          { raw },
        );
      }
      if (!/^\d+$/.test(amountWei)) {
        throw new AgentkitRuntimeError(
          ErrorCodes.INVALID_INPUT,
          `order amountWei is not a base-10 integer: "${amountWei}"`,
        );
      }

      const nowSec = Math.floor(Date.now() / 1000);
      if (nowSec >= expiresAt - EXPIRY_SAFETY_MARGIN_SEC) {
        throw new AgentkitRuntimeError(
          ErrorCodes.INVALID_INPUT,
          `order_not_payable: within ${EXPIRY_SAFETY_MARGIN_SEC}s expiry margin (now=${nowSec}, expiresAt=${expiresAt})`,
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
