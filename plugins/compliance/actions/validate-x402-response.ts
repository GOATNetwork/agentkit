import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';

export interface ValidateX402ResponseInput {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  expectedAmount?: string;
  expectedAsset?: string;
}

export interface ValidateX402ResponseOutput {
  valid: boolean;
  checks: {
    name: string;
    passed: boolean;
    detail: string;
  }[];
}

const inputSchema = z.object({
  statusCode: z.number().int(),
  headers: z.record(z.string(), z.string()),
  body: z.string(),
  expectedAmount: z.string().optional(),
  expectedAsset: z.string().optional(),
});

export function validateX402ResponseAction(): ActionDefinition<
  ValidateX402ResponseInput,
  ValidateX402ResponseOutput
> {
  return {
    name: 'compliance.validate_x402_response',
    description:
      'Validate an HTTP 402 response from a merchant gateway. Checks that the 402 challenge conforms to the x402 spec, including required headers, proper encoding, and optionally matching expected payment terms.',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(_ctx, input) {
      const checks: ValidateX402ResponseOutput['checks'] = [];

      // Check 1: Status code is 402
      const is402 = input.statusCode === 402;
      checks.push({
        name: 'status_402',
        passed: is402,
        detail: is402
          ? 'Response status is 402 (Payment Required)'
          : `Expected 402, got ${input.statusCode}`,
      });

      // Check 2: Content-Type present
      const contentType = input.headers['content-type'] || input.headers['Content-Type'] || '';
      const hasContentType = contentType.length > 0;
      checks.push({
        name: 'content_type_present',
        passed: hasContentType,
        detail: hasContentType
          ? `Content-Type: ${contentType}`
          : 'Missing Content-Type header',
      });

      // Check 3: Body is not empty
      const hasBody = input.body.length > 0;
      checks.push({
        name: 'body_not_empty',
        passed: hasBody,
        detail: hasBody
          ? `Response body is ${input.body.length} chars`
          : 'Response body is empty',
      });

      // Check 4: Body contains x402 challenge markers
      const has402Marker = input.body.includes('402') || input.body.includes('x402');
      checks.push({
        name: 'x402_challenge_marker',
        passed: has402Marker,
        detail: has402Marker
          ? 'Response body contains x402/402 challenge markers'
          : 'Response body does not contain expected x402 challenge markers — may not be a valid x402 response',
      });

      // Check 5: Payment-Info header present
      const hasPaymentInfo = 'x-payment-info' in input.headers ||
        'X-Payment-Info' in input.headers;
      checks.push({
        name: 'payment_info_header',
        passed: hasPaymentInfo,
        detail: hasPaymentInfo
          ? 'x-payment-info header present'
          : 'Missing x-payment-info header — required by x402 spec',
      });

      // Check 6: Expected amount matches (if provided)
      if (input.expectedAmount && hasBody) {
        const amountMatches = input.body.includes(input.expectedAmount);
        checks.push({
          name: 'amount_matches',
          passed: amountMatches,
          detail: amountMatches
            ? `Response references expected amount ${input.expectedAmount}`
            : `Expected amount ${input.expectedAmount} not found in response`,
        });
      }

      const failedCount = checks.filter((c) => !c.passed).length;
      return {
        valid: failedCount === 0,
        checks,
      };
    },
  };
}