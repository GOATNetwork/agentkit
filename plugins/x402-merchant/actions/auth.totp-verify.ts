import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { MerchantPortalClient } from '../adapters/types';

const schema = z.object({ mfa_token: z.string().min(1), code: z.string().regex(/^\d{6}$/) }).strict();

export function merchantAuthTotpVerifyAction(client: MerchantPortalClient): ActionDefinition {
  return {
    name: 'goat.x402.merchant.auth.totp-verify',
    description: 'Complete GOAT Flow merchant login with its MFA challenge token and six-digit TOTP code',
    riskLevel: 'medium',
    requiresConfirmation: true,
    retryable: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: schema,
    sensitiveInputFields: ['mfa_token', 'code'],
    sensitiveOutputFields: ['access_token', 'refresh_token'],
    execute: (ctx, input) => client.post('/merchant/v1/auth/totp/verify', input, { signal: ctx.signal }),
  };
}
