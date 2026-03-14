import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { getIdentityRegistryAddress } from '../addresses';

export interface GetMetadataInput {
  agentId: string;
  metadataKey: string;
}

export interface GetMetadataOutput {
  agentId: string;
  metadataKey: string;
  metadataValue: string;
}

const inputSchema = z.object({
  agentId: z.string().regex(/^\d+$/, 'agentId must be a numeric string'),
  metadataKey: z.string().min(1, 'metadataKey must not be empty'),
});

const GET_METADATA_ABI = ['function getMetadata(uint256 agentId, string metadataKey) view returns (bytes)'];

export function erc8004GetMetadataAction(
  wallet: WalletProvider,
): ActionDefinition<GetMetadataInput, GetMetadataOutput> {
  return {
    name: 'erc8004.get_metadata',
    description: 'Read a metadata entry for an agent from the ERC-8004 Identity Registry',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      const result = await wallet.callContract(
        getIdentityRegistryAddress(ctx.network),
        GET_METADATA_ABI,
        'getMetadata',
        [BigInt(input.agentId), input.metadataKey],
      );
      return {
        agentId: input.agentId,
        metadataKey: input.metadataKey,
        metadataValue: String(result),
      };
    },
  };
}
