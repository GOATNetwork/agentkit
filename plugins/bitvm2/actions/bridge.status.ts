import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { GoatAdapter } from '../../../networks/goat/adapter';

export interface BridgeStatusInput {
  bridgeRequestId: string;
}

export interface BridgeStatusOutput {
  bridgeRequestId: string;
  status:
    | 'CREATED'
    | 'PENDING_L1'
    | 'PROVING'
    | 'PROVED'
    | 'FINALIZING'
    | 'FINALIZED'
    | 'FAILED';
}

const inputSchema = z.object({
  bridgeRequestId: z.string().min(3),
});

export function bridgeStatusAction(adapter: GoatAdapter): ActionDefinition<BridgeStatusInput, BridgeStatusOutput> {
  return {
    name: 'goat.bitvm2.bridge.status',
    description: 'Track BitVM2 bridge request status',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(_ctx, input) {
      return adapter.bitvm2GetStatus(input.bridgeRequestId);
    },
  };
}
