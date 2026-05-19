import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import { AgentkitRuntimeError } from '../../../core/errors/error';
import { ErrorCodes } from '../../../core/errors/error-codes';
import type { CalldataSignRequest, PayerWalletAdapter } from '../../x402/adapters/types';
import type { GnsApiAdapter } from '../adapters/types';

const signReqSchema = z.object({
  domain: z.record(z.unknown()),
  types: z.record(z.array(z.object({ name: z.string(), type: z.string() }))),
  primaryType: z.string().min(1),
  message: z.record(z.unknown()),
});

const inputSchema = z.object({
  orderId: z.string().min(1),
  calldataSignRequest: signReqSchema as unknown as z.ZodType<CalldataSignRequest>,
});

export type X402SubmitSignatureInput = z.infer<typeof inputSchema>;

export interface X402SubmitSignatureOutput {
  orderId: string;
  status: 'authorized' | 'failed';
}

const outputSchema: z.ZodType<X402SubmitSignatureOutput> = z.object({
  orderId: z.string(),
  status: z.union([z.literal('authorized'), z.literal('failed')]),
});

/**
 * `goat.gns.x402.submitSignature` — sign the order's `calldataSignRequest`
 * with the GOAT-bound `PayerWalletAdapter` (the GoatX402 adaptor lives on
 * GOAT, so the EIP-712 domain references the GOAT chainId/verifyingContract)
 * and forward the signature to `POST /payments/x402/orders/:orderId/calldata-signature`.
 *
 * Reuses `EvmPayerWalletAdapter` from the existing `plugins/x402` plugin
 * verbatim. Callers in a cross-chain flow construct **two** adapter
 * instances (Codex R3 #A):
 *
 *   ```ts
 *   import { EvmPayerWalletAdapter } from '@goatnetwork/agentkit/plugins/x402';
 *
 *   const goatPayerAdapter   = new EvmPayerWalletAdapter(goatSigner);    // for submitSignature
 *   const sourcePayerAdapter = new EvmPayerWalletAdapter(sourceSigner);  // for payOrder
 *   ```
 *
 * `goatSigner` is bound to the GOAT RPC (mainnet 2345 / testnet3 48816);
 * `sourceSigner` is bound to whichever source chain the user is paying from
 * (Base 8453, Polygon 137, etc.). Sharing a single adapter would either sign
 * with the wrong chainId or attempt the ERC-20 transfer on the wrong chain.
 *
 * On `'failed'` from the gateway the action throws
 * `AgentkitRuntimeError(ADAPTER_REQUEST_FAILED, ...)`.
 */
export function x402SubmitSignatureAction(
  api: GnsApiAdapter,
  payer: PayerWalletAdapter,
): ActionDefinition<X402SubmitSignatureInput, X402SubmitSignatureOutput> {
  return {
    name: 'goat.gns.x402.submitSignature',
    description: 'Sign the GoatX402 callback typed data on the GOAT adaptor chain and authorize the order',
    riskLevel: 'high',
    requiresConfirmation: true,
    networks: [],
    zodInputSchema: inputSchema,
    zodOutputSchema: outputSchema,
    async execute(ctx, input) {
      const signature = await payer.signCalldataTypedData(input.calldataSignRequest);
      const resp = await api.submitX402Signature(input.orderId, signature, ctx.signal);
      if (resp.status === 'failed') {
        throw new AgentkitRuntimeError(
          ErrorCodes.ADAPTER_REQUEST_FAILED,
          `gns x402 submitSignature gateway returned failed for order ${input.orderId}`,
          resp.raw,
        );
      }
      return { orderId: input.orderId, status: resp.status };
    },
  };
}
