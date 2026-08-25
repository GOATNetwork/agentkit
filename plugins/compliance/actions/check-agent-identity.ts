import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { getIdentityRegistryAddress, getReputationRegistryAddress } from '../../erc8004/addresses';

export interface CheckAgentIdentityInput {
  agentId: string;
  network: string;
  threshold?: number;
}

export interface CheckAgentIdentityOutput {
  agentId: string;
  registered: boolean;
  reputationScore: number | null;
  meetsThreshold: boolean;
  detail: string;
}

const inputSchema = z.object({
  agentId: z.string().regex(/^\d+$/, 'agentId must be a numeric string'),
  network: z.string(),
  threshold: z.number().min(0).max(100).optional().default(50),
});

const GET_AGENT_ABI = [
  'function getAgent(uint256 agentId) view returns (address owner, string uri, bool active)',
];

const GET_SUMMARY_ABI = [
  'function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)',
];

export function checkAgentIdentityAction(
  wallet: WalletProvider,
): ActionDefinition<CheckAgentIdentityInput, CheckAgentIdentityOutput> {
  return {
    name: 'compliance.check_agent_identity',
    description:
      'Check an ERC-8004 agent identity for compliance. Verifies the agent is registered in the identity registry, has a reputation score, and meets a configurable threshold. Use this before transacting with an unknown agent.',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      let registered = false;
      let reputationScore: number | null = null;
      let detail = '';

      try {
        const identityRegistry = getIdentityRegistryAddress(input.network);
        const result = await wallet.callContract(
          identityRegistry,
          GET_AGENT_ABI,
          'getAgent',
          [BigInt(input.agentId)],
        ) as any[];

        registered = result && result.length >= 3 && result[2] === true;
        detail = registered
          ? `Agent #${input.agentId} is registered (owner: ${(result as any[])[0]})`
          : `Agent #${input.agentId} was found but is not active`;
      } catch (e) {
        detail = `Could not verify agent #${input.agentId}: ${(e as Error).message}`;
      }

      // Try reputation check
      if (registered) {
        try {
          const reputationRegistry = getReputationRegistryAddress(input.network);
          const repResult = await wallet.callContract(
            reputationRegistry,
            GET_SUMMARY_ABI,
            'getSummary',
            [BigInt(input.agentId), [], '', ''],
          ) as any[];

          if (repResult && repResult.length >= 2) {
            const rawValue = Number(repResult[1]);
            const decimals = Number(repResult[2]) || 0;
            reputationScore = rawValue / Math.pow(10, decimals);
          }
        } catch {
          // Reputation registry may not be available
          detail += ' (reputation unavailable)';
        }
      }

      const meetsThreshold = reputationScore !== null
        ? reputationScore >= (input.threshold || 50)
        : !registered; // if no reputation, only pass if not registered (no risk)

      return {
        agentId: input.agentId,
        registered,
        reputationScore,
        meetsThreshold,
        detail,
      };
    },
  };
}