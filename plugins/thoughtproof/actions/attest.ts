import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { ThoughtProofAdapter, AttestInput, AttestOutput } from '../adapters/types';

const inputSchema = z.object({
  source: z.enum(['sentinel', 'rv']).describe(
    'Which verification result to attest: "sentinel" → EAS on-chain attestation, "rv" → TP-VC attestation',
  ),
  requestId: z.string().min(1, 'requestId from the verification response is required'),
  recipient: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'recipient must be a valid EVM address'),
});

/**
 * On-chain attestation of a ThoughtProof verification result.
 *
 * Creates a permanent, verifiable record of the verification:
 * - source="sentinel" → EAS attestation on Base mainnet
 * - source="rv" → ThoughtProof Verifiable Credential (TP-VC)
 *
 * Requires the requestId from a prior sentinel or verify call.
 */
export function thoughtproofAttestAction(
  adapter: ThoughtProofAdapter,
): ActionDefinition<AttestInput, AttestOutput> {
  return {
    name: 'thoughtproof.attest',
    description:
      'Create an on-chain attestation of a verification result. ' +
      'Pass source="sentinel" for EAS attestation or source="rv" for TP-VC. ' +
      'Requires the requestId from a prior thoughtproof.sentinel or thoughtproof.verify call. ' +
      'The recipient address receives the attestation.',
    riskLevel: 'medium',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      return adapter.attest(input, ctx.signal);
    },
  };
}
