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
 * (card code, recovery phrase, etc.) to the operator without leaking
 * it to telemetry pipelines.
 *
 * The action ALWAYS writes `input.value` (preceded by optional label)
 * to process.stdout. The protection model has three layers:
 *   1. `sensitiveInputFields: ['value']` — onActionStart hook receives
 *      `value: '[REDACTED]'`, so any subscribed logger / telemetry sink
 *      never sees the plaintext.
 *   2. stdout is a local sink that bypasses every logger in the host
 *      process — capturing it requires explicit stream redirection.
 *   3. The caller decides whether to invoke print-secret at all; it is
 *      not chained automatically by any other action.
 *
 * Callers MUST treat this action as the explicit "show this once" step
 * and avoid wrapping it in framework adapters that capture stdout.
 */
export function printSecretAction(): ActionDefinition<PrintSecretInput, PrintSecretOutput> {
  return {
    name: 'agentkit.print-secret',
    description:
      'Print a sensitive value (e.g. gift card code) to local stdout once. Telemetry sees [REDACTED] via sensitiveInputFields; stdout receives plaintext for the operator.',
    riskLevel: 'low',
    requiresConfirmation: false,
    networks: [],
    zodInputSchema: inputSchema,
    zodOutputSchema: outputSchema,
    sensitiveInputFields: ['value'],
    sensitiveOutputFields: [],
    async execute(_ctx, input) {
      // stdout bypasses every logger in the host process — that is the
      // entire point of this action; do not switch to a logger here.
      const label = input.label ? `${input.label}: ` : '';
      process.stdout.write(`${label}${input.value}\n`);
      return { printed: true };
    },
  };
}
