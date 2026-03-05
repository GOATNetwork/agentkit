import type { ActionDefinition, ActionContext, RiskLevel } from '../schema/action';

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
}

export interface PolicyInput {
  action: ActionDefinition;
  context: ActionContext;
  payload: unknown;
  confirmed?: boolean;
}

export interface PolicyConfig {
  allowedNetworks: string[];
  maxRiskWithoutConfirm: RiskLevel;
  writeEnabled: boolean;
}

const riskScore: Record<RiskLevel, number> = {
  read: 0,
  low: 1,
  medium: 2,
  high: 3,
};

export class PolicyEngine {
  constructor(private readonly config: PolicyConfig) {}

  evaluate(input: PolicyInput): PolicyDecision {
    const { action, context, confirmed } = input;

    if (!this.config.allowedNetworks.includes(context.network)) {
      return { allowed: false, reason: `Network not allowed: ${context.network}` };
    }

    if (action.networks.length > 0 && !action.networks.includes(context.network)) {
      return { allowed: false, reason: `Action ${action.name} does not support network: ${context.network}` };
    }

    if (!this.config.writeEnabled && action.riskLevel !== 'read') {
      return { allowed: false, reason: 'Write actions are disabled by policy' };
    }

    if (
      riskScore[action.riskLevel] > riskScore[this.config.maxRiskWithoutConfirm] &&
      !confirmed
    ) {
      return { allowed: false, reason: `Confirmation required for risk level: ${action.riskLevel}` };
    }

    if (action.requiresConfirmation && !confirmed) {
      return { allowed: false, reason: 'Action explicitly requires confirmation' };
    }

    return { allowed: true };
  }
}
