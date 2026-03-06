import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import { GoatAdapter } from '../../../networks/goat/adapter';
import { evmAddress } from '../../../core/schema/validators';

export interface PeginRequestInput {
  receiverEvmAddress: string;
  amountSats: string;
}

export interface PeginRequestOutput {
  bridgeRequestId: string;
  status: 'CREATED' | 'PENDING_L1';
}

const inputSchema = z.object({
  receiverEvmAddress: evmAddress,
  amountSats: z.string().regex(/^\d+$/, 'amountSats must be a numeric string. Minimum: 50000 sats'),
});

export function bitvm2PeginRequestAction(
  adapter: GoatAdapter,
): ActionDefinition<PeginRequestInput, PeginRequestOutput> {
  return {
    name: 'goat.bitvm2.pegin.request',
    description: 'Request a peg-in (BTC L1 → Goat L2) via the BitVM2 bridge. Submits a peg-in request to GoatChain. After requesting, the user must deposit BTC on L1 to the generated address. Minimum deposit: 50,000 sats. Operator graph prepayment: ~10,000 sats.',
    riskLevel: 'high',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      const res = await adapter.bitvm2Deposit({
        fromAddress: '',
        toAddress: input.receiverEvmAddress,
        amountSats: input.amountSats,
      });
      return {
        bridgeRequestId: res.bridgeRequestId,
        status: 'CREATED',
      };
    },
  };
}
