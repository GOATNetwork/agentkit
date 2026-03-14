import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { getIdentityRegistryAddress } from '../addresses';

export interface SetAgentURIInput {
  agentId: string;
  newURI: string;
}

export interface SetAgentURIOutput {
  txHash: string;
}

const inputSchema = z.object({
  agentId: z.string().regex(/^\d+$/, 'agentId must be a numeric string'),
  newURI: z.string().min(1, 'newURI must not be empty'),
});

const SET_URI_ABI = ['function setAgentURI(uint256 agentId, string newURI)'];

export function erc8004SetAgentURIAction(
  wallet: WalletProvider,
): ActionDefinition<SetAgentURIInput, SetAgentURIOutput> {
  return {
    name: 'erc8004.set_agent_uri',
    description: 'Update the registration URI for an agent in the ERC-8004 Identity Registry. Only the agent owner can call this.',
    riskLevel: 'medium',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      return wallet.writeContract(
        getIdentityRegistryAddress(ctx.network),
        SET_URI_ABI,
        'setAgentURI',
        [BigInt(input.agentId), input.newURI],
        undefined,
        { signal: ctx.signal },
      );
    },
  };
}
