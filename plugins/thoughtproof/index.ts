// ThoughtProof Plugin for GOAT AgentKit
// Epistemic verification layer: Sentinel (triage) + RV (deep verification)

export { thoughtproofSentinelAction } from './actions/sentinel';
export { thoughtproofVerifyAction } from './actions/verify';
export { thoughtproofAttestAction } from './actions/attest';
export { thoughtproofStatusAction } from './actions/status';

export { HttpThoughtProofAdapter } from './adapters/http-thoughtproof';

export type {
  ThoughtProofAdapter,
  ThoughtProofConfig,
  X402Signer,
  Verdict,
  SentinelVerifyInput,
  SentinelVerifyOutput,
  RVTier,
  RVVerifyInput,
  RVVerifyOutput,
  AttestationSource,
  AttestInput,
  AttestOutput,
  StatusOutput,
} from './adapters/types';

export type { ReputationHookConfig } from './hooks/reputation';
export { submitReputationFeedback } from './hooks/reputation';
