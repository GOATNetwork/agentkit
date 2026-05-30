import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import type { SentinelVerifyOutput, RVVerifyOutput, Verdict } from '../adapters/types';

/**
 * Internal post-verification hook that submits ERC-8004 reputation
 * feedback based on verification results.
 *
 * NOT exposed as an agent action — this runs automatically after
 * verification to prevent agents from gaming their own reputation.
 *
 * Called by the plugin internally after sentinel/verify actions complete.
 */

const REPUTATION_REGISTRY_ABI = [
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
];

// Default addresses — override via ReputationHookConfig.registryAddresses
const DEFAULT_REPUTATION_ADDRESSES: Record<string, string> = {
  'goat-mainnet': '0x8004BAa1000000000000000000000000000000a1',
  'goat-testnet': '0xd914000000000000000000000000000000a964',
};

function verdictToScore(verdict: Verdict): number {
  switch (verdict) {
    case 'ALLOW': return 100;
    case 'UNCERTAIN': return 50;
    case 'BLOCK': return 0;
  }
}

export interface ReputationHookConfig {
  /** ERC-8004 agent ID to submit feedback for */
  agentId: string;
  /** Whether to submit reputation feedback (default: true) */
  enabled?: boolean;
  /** Override reputation registry addresses per network */
  registryAddresses?: Record<string, string>;
}

/**
 * Submit verification result as ERC-8004 reputation feedback.
 *
 * Tags:
 * - tag1: "thoughtproof" (verifier identity)
 * - tag2: "sentinel" | "rv" (verification type)
 *
 * Score mapping:
 * - ALLOW  → 100 (decimals=0)
 * - UNCERTAIN → 50
 * - BLOCK  → 0
 */
export async function submitReputationFeedback(
  wallet: WalletProvider,
  network: string,
  config: ReputationHookConfig,
  source: 'sentinel' | 'rv',
  result: SentinelVerifyOutput | RVVerifyOutput,
): Promise<{ txHash: string } | null> {
  if (config.enabled === false) return null;

  const registryAddress = config.registryAddresses?.[network] ?? DEFAULT_REPUTATION_ADDRESSES[network];
  if (!registryAddress) return null;

  const score = verdictToScore(result.verdict);

  // Build a deterministic feedback hash from requestId
  const encoder = new TextEncoder();
  const data = encoder.encode(`thoughtproof:${source}:${result.requestId}`);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const feedbackHash = '0x' + hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  try {
    return await wallet.writeContract(
      registryAddress,
      REPUTATION_REGISTRY_ABI,
      'giveFeedback',
      [
        BigInt(config.agentId),
        score,
        0, // decimals
        'thoughtproof',
        source,
        `thoughtproof.${source}`,
        `thoughtproof://${result.requestId}`,
        feedbackHash,
      ],
    );
  } catch {
    // Reputation submission is best-effort — don't block verification
    return null;
  }
}
