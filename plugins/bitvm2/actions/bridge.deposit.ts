import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import { GoatAdapter } from '../../../networks/goat/adapter';
import { evmAddress } from '../../../core/schema/validators';

export interface BridgeDepositInput {
  fromBtcAddress: string;
  toGoatAddress: string;
  amountSats: string;
}

export interface BridgeDepositOutput {
  bridgeRequestId: string;
  status: 'CREATED' | 'PENDING_L1';
}

const inputSchema = z.object({
  fromBtcAddress: z.string().min(10),
  toGoatAddress: evmAddress,
  amountSats: z.string().regex(/^\d+$/),
});

export function bridgeDepositAction(
  adapter: GoatAdapter
): ActionDefinition<BridgeDepositInput, BridgeDepositOutput> {
  return {
    name: 'goat.bitvm2.bridge.deposit',
    description: 'Start BTC L1 -> Goat L2 deposit via BitVM2 bridge',
    riskLevel: 'high',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(_ctx, input) {
      const res = await adapter.bitvm2Deposit({
        fromAddress: input.fromBtcAddress,
        toAddress: input.toGoatAddress,
        amountSats: input.amountSats,
      });
      return {
        bridgeRequestId: res.bridgeRequestId,
        status: 'CREATED',
      };
    },
  };
}
