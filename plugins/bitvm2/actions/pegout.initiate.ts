import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import { GoatAdapter } from '../../../networks/goat/adapter';
import { evmAddress } from '../../../core/schema/validators';

export interface PegoutInitiateInput {
  fromGoatAddress: string;
  toBtcAddress: string;
  amountSats: string;
}

export interface PegoutInitiateOutput {
  bridgeRequestId: string;
  status: 'CREATED' | 'FINALIZING';
}

const inputSchema = z.object({
  fromGoatAddress: evmAddress,
  toBtcAddress: z.string().min(10, 'toBtcAddress must be a valid Bitcoin address'),
  amountSats: z.string().regex(/^\d+$/),
});

export function bitvm2PegoutInitiateAction(
  adapter: GoatAdapter,
): ActionDefinition<PegoutInitiateInput, PegoutInitiateOutput> {
  return {
    name: 'goat.bitvm2.pegout.initiate',
    description: 'Initiate a peg-out (Goat L2 → BTC L1) via the BitVM2 bridge Gateway.initWithdraw. Requires a running Operator node. The operator will process the withdrawal and send BTC on L1.',
    riskLevel: 'high',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      const res = await adapter.bitvm2Withdraw({
        fromAddress: input.fromGoatAddress,
        toAddress: input.toBtcAddress,
        amountSats: input.amountSats,
      });
      return {
        bridgeRequestId: res.bridgeRequestId,
        status: 'CREATED',
      };
    },
  };
}
