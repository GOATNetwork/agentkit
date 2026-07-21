import type { ActionDefinition } from '../../../core/schema/action';
import type { ThoughtProofAdapter, StatusOutput } from '../adapters/types';

/**
 * Health check for both ThoughtProof APIs (Sentinel + RV).
 * No input required. Returns health status and latency for each backend.
 */
export function thoughtproofStatusAction(
  adapter: ThoughtProofAdapter,
): ActionDefinition<Record<string, never>, StatusOutput> {
  return {
    name: 'thoughtproof.status',
    description:
      'Check health of ThoughtProof verification APIs. ' +
      'Returns availability and latency for both Sentinel and RV backends. ' +
      'Call before critical verification flows to ensure services are reachable.',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    async execute(ctx) {
      return adapter.status(ctx.signal);
    },
  };
}
