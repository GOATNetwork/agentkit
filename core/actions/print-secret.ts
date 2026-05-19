import { z } from 'zod';
import type { ActionDefinition } from '../schema/action';

export interface PrintSecretInput {
  value: string;
  label?: string;
}

export interface PrintSecretOutput {
  printed: true;
}

const inputSchema = z.object({
  value: z.string().min(1),
  label: z.string().optional(),
});

const outputSchema = z.object({ printed: z.literal(true) });

/**
 * agentkit.print-secret — local sink for surfacing a sensitive value
 * (card code, recovery phrase, etc.) without writing it to hooks/logs.
 *
 * Writes value to process.stdout ONLY when ExecutionOptions.revealedFields
 * includes 'value' on this call. Otherwise prints '[REDACTED]'.
 *
 * Both `value` (input) and the runtime's output redaction protect against
 * accidental telemetry leak.
 */
export function printSecretAction(): ActionDefinition<PrintSecretInput, PrintSecretOutput> {
  return {
    name: 'agentkit.print-secret',
    description:
      'Print a sensitive value (e.g. card code) to local stdout once. Use ExecutionOptions.revealedFields:["value"] to actually print plaintext; defaults to redacted.',
    riskLevel: 'low',
    requiresConfirmation: false,
    networks: [],
    zodInputSchema: inputSchema,
    zodOutputSchema: outputSchema,
    sensitiveInputFields: ['value'],
    sensitiveOutputFields: [],
    async execute(_ctx, input) {
      // Note: stdout.write here is intentional — we want to bypass
      // any logger that might forward to telemetry.
      const label = input.label ? `${input.label}: ` : '';
      process.stdout.write(`${label}${input.value}\n`);
      return { printed: true };
    },
  };
}
