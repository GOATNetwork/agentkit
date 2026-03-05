import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import { GoatAdapter } from '../../../networks/goat/adapter';
import { evmAddress } from '../../../core/schema/validators';

export interface BridgeWithdrawInput {
  fromGoatAddress: string;
  toBtcAddress: string;
  amountSats: string;
}

export interface BridgeWithdrawOutput {
  bridgeRequestId: string;
  status: 'CREATED' | 'FINALIZING';
}

const inputSchema = z.object({
  fromGoatAddress: evmAddress,
  toBtcAddress: z.string().min(10),
  amountSats: z.string().regex(/^\d+$/),
});

export function bridgeWithdrawAction(
  adapter: GoatAdapter
): ActionDefinition<BridgeWithdrawInput, BridgeWithdrawOutput> {
  return {
    name: 'goat.bitvm2.bridge.withdraw',
    description: 'Start Goat L2 -> BTC L1 withdraw via BitVM2 bridge',
    riskLevel: 'high',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(_ctx, input) {
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
