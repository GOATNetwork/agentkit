import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { IDENTITY_REGISTRY_ADDRESS } from './register-agent';

export interface SetMetadataInput {
  agentId: string;
  metadataKey: string;
  metadataValue: string;
}

export interface SetMetadataOutput {
  txHash: string;
}

const inputSchema = z.object({
  agentId: z.string().regex(/^\d+$/, 'agentId must be a numeric string'),
  metadataKey: z.string().min(1, 'metadataKey must not be empty'),
  metadataValue: z.string(),
});

const SET_METADATA_ABI = ['function setMetadata(uint256 agentId, string metadataKey, bytes metadataValue)'];

export function erc8004SetMetadataAction(
  wallet: WalletProvider,
): ActionDefinition<SetMetadataInput, SetMetadataOutput> {
  return {
    name: 'erc8004.set_metadata',
    description: 'Set a metadata entry for an agent in the ERC-8004 Identity Registry. Only the agent owner can call this.',
    riskLevel: 'medium',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      return wallet.writeContract(
        IDENTITY_REGISTRY_ADDRESS,
        SET_METADATA_ABI,
        'setMetadata',
        [BigInt(input.agentId), input.metadataKey, input.metadataValue],
        undefined,
        { signal: ctx.signal },
      );
    },
  };
}
