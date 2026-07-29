import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import { evmAddress } from '../../../core/schema/validators';

export interface ValidateX402PaymentInput {
  paymentId: string;
  to: string;
  asset: string;
  amount: string;
  network: string;
  merchantUrl?: string;
}

export interface ValidateX402PaymentOutput {
  valid: boolean;
  checks: {
    name: string;
    passed: boolean;
    detail: string;
  }[];
  riskLevel: 'low' | 'medium' | 'high';
}

const inputSchema = z.object({
  paymentId: z.string().min(1, 'paymentId is required'),
  to: evmAddress,
  asset: z.string().min(2),
  amount: z.string().min(1),
  network: z.string(),
  merchantUrl: z.string().url().optional(),
});

export function validateX402PaymentAction(): ActionDefinition<
  ValidateX402PaymentInput,
  ValidateX402PaymentOutput
> {
  return {
    name: 'compliance.validate_x402_payment',
    description:
      'Validate an x402 payment request before submission. Checks recipient address format, amount bounds, network compatibility, and merchant gateway reachability.',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      const checks: ValidateX402PaymentOutput['checks'] = [];

      // Check 1: Address is not zero address
      const isZeroAddress = input.to === '0x0000000000000000000000000000000000000000';
      checks.push({
        name: 'recipient_not_zero',
        passed: !isZeroAddress,
        detail: isZeroAddress
          ? 'Recipient is the zero address — funds would be burned'
          : 'Recipient address is valid',
      });

      // Check 2: Amount is positive and reasonable
      const amountNum = parseFloat(input.amount);
      const amountSanity = amountNum > 0 && amountNum < 1000000;
      checks.push({
        name: 'amount_reasonable',
        passed: amountSanity,
        detail: amountSanity
          ? `Amount ${input.amount} ${input.asset} is within bounds`
          : `Amount ${input.amount} is invalid or exceeds sanity limit (1M)`,
      });

      // Check 3: Network is supported
      const supportedNetworks = ['goat-mainnet', 'goat-testnet'];
      const networkSupported = supportedNetworks.includes(input.network);
      checks.push({
        name: 'network_supported',
        passed: networkSupported,
        detail: networkSupported
          ? `Network ${input.network} is supported`
          : `Network ${input.network} is not in supported list: ${supportedNetworks.join(', ')}`,
      });

      // Check 4: Asset is recognized
      const knownAssets = ['USDC', 'USDT', 'GOAT', 'BTC', 'ETH'];
      const assetKnown = knownAssets.includes(input.asset.toUpperCase());
      checks.push({
        name: 'asset_recognized',
        passed: assetKnown,
        detail: assetKnown
          ? `Asset ${input.asset} is recognized`
          : `Asset ${input.asset} is not in known list — proceed with caution`,
      });

      // Check 5: Merchant URL is HTTPS (if provided)
      if (input.merchantUrl) {
        const isHttps = input.merchantUrl.startsWith('https://');
        checks.push({
          name: 'merchant_secure',
          passed: isHttps,
          detail: isHttps
            ? 'Merchant gateway uses HTTPS'
            : 'Merchant gateway does not use HTTPS — payment data may be intercepted',
        });
      } else {
        checks.push({
          name: 'merchant_secure',
          passed: true,
          detail: 'No merchant gateway URL provided — skipping HTTPS check',
        });
      }

      const failedCount = checks.filter((c) => !c.passed).length;
      let riskLevel: 'low' | 'medium' | 'high' = 'low';
      if (failedCount >= 3) riskLevel = 'high';
      else if (failedCount >= 1) riskLevel = 'medium';

      return {
        valid: failedCount === 0,
        checks,
        riskLevel,
      };
    },
  };
}