/**
 * ThoughtProof API adapter types.
 *
 * Two backend APIs:
 * - Sentinel: sentinel.thoughtproof.ai/sentinel/verify
 * - RV:      api.thoughtproof.ai/v1/verify
 */

// ── Shared ──────────────────────────────────────────────────

export type Verdict = 'ALLOW' | 'BLOCK' | 'UNCERTAIN';

/**
 * x402 signer interface — any object that can sign EIP-712 typed data.
 * Compatible with viem's `privateKeyToAccount()` and ethers' `Wallet`.
 */
export interface X402Signer {
  /** Sign EIP-712 typed data. Compatible with viem Account or ethers Signer. */
  signTypedData?(args: {
    domain: Record<string, unknown>;
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<string>;
  /** EVM address of the signer */
  address?: string;
}

export interface ThoughtProofConfig {
  /** Sentinel API base URL (default: https://sentinel.thoughtproof.ai) */
  sentinelBaseUrl?: string;
  /** RV API base URL (default: https://api.thoughtproof.ai) */
  rvBaseUrl?: string;
  /** API key for authenticated requests. Ignored when x402Signer is provided. */
  apiKey?: string;
  /**
   * Maximum payment amount (in smallest unit, e.g. USDC micro-units) the adapter
   * will sign per request. Prevents a compromised server from draining the wallet.
   * Default: no limit. Recommended: set to 10x your expected max per-call cost.
   */
  maxPaymentAmount?: string;
  /**
   * x402 wallet signer for pay-per-call verification.
   * When provided, the adapter pays via x402 (HTTP 402) instead of using an API key.
   * The server dictates the price — the adapter just signs and pays.
   *
   * Pass a viem account: `privateKeyToAccount('0x...')`
   * Or any object implementing X402Signer.
   */
  x402Signer?: X402Signer;
  /**
   * Custom fetch function with x402 payment handling already wired in.
   * Use this if you've already set up `@x402/fetch` `wrapFetchWithPayment()`.
   * When provided, x402Signer is ignored (you handle payment externally).
   */
  x402Fetch?: typeof fetch;
  /** Timeout in ms for API calls (default: 30_000 for Sentinel, 120_000 for RV) */
  sentinelTimeoutMs?: number;
  rvTimeoutMs?: number;
}

// ── API Response Shapes ─────────────────────────────────────
//
// Sentinel API (sentinel.thoughtproof.ai) returns snake_case:
//   { verdict, confidence, reasons, request_id, ... }
//
// RV API (api.thoughtproof.ai) returns snake_case:
//   { verdict, confidence, evaluation, critique, synthesis, request_id, ... }
//
// The adapter normalizes both to camelCase TypeScript interfaces below.
// Defensive fallback to camelCase keys exists in case API changes.

// ── Sentinel ────────────────────────────────────────────────

export interface SentinelVerifyInput {
  /** The agent's reasoning or planned action to verify */
  claim: string;
  /** Context / instructions the agent was given */
  context?: string;
  /** The agent's task or goal */
  task?: string;
}

export interface SentinelVerifyOutput {
  verdict: Verdict;
  confidence: number;
  reasons: string[];
  /** Request ID for tracing */
  requestId: string;
  /** Latency in ms */
  latencyMs: number;
}

// ── RV (Reality Verification) ───────────────────────────────

export type RVTier = 'standard' | 'deep';

export interface RVVerifyInput {
  /** The claim or agent output to verify */
  claim: string;
  /** Supporting context or evidence */
  context?: string;
  /** Verification depth */
  tier: RVTier;
  /** Domain hint for domain-specific verification profiles */
  domain?: string;
}

export interface RVVerifyOutput {
  verdict: Verdict;
  confidence: number;
  /** Adversarial evaluation result */
  evaluation: string;
  /** Red-team critique */
  critique: string;
  /** Final synthesized reasoning */
  synthesis: string;
  /** Request ID for tracing */
  requestId: string;
  /** Latency in ms */
  latencyMs: number;
}

// ── Attestation ─────────────────────────────────────────────

export type AttestationSource = 'sentinel' | 'rv';

export interface AttestInput {
  /** Which verification result to attest */
  source: AttestationSource;
  /** The request ID from the verification response */
  requestId: string;
  /** Recipient address for the attestation */
  recipient: string;
}

export interface AttestOutput {
  /** EAS attestation UID (for Sentinel) or TP-VC ID (for RV) */
  attestationId: string;
  /** Transaction hash if on-chain */
  txHash?: string;
}

// ── Status ──────────────────────────────────────────────────

export interface StatusOutput {
  sentinel: { healthy: boolean; latencyMs: number };
  rv: { healthy: boolean; latencyMs: number };
}

// ── Adapter Interface ───────────────────────────────────────

export interface ThoughtProofAdapter {
  sentinelVerify(input: SentinelVerifyInput, signal?: AbortSignal): Promise<SentinelVerifyOutput>;
  rvVerify(input: RVVerifyInput, signal?: AbortSignal): Promise<RVVerifyOutput>;
  attest(input: AttestInput, signal?: AbortSignal): Promise<AttestOutput>;
  status(signal?: AbortSignal): Promise<StatusOutput>;
}
