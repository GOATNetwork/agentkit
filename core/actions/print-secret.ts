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
 * (card code, recovery phrase, etc.) to the operator while keeping it
 * out of in-SDK logging and hook payloads.
 *
 * The action ALWAYS writes `input.value` (preceded by optional label)
 * to process.stdout. The protection model has three layers:
 *   1. `sensitiveInputFields: ['value']` — onActionStart hook receives
 *      `value: '[REDACTED]'`, so any logger or telemetry sink wired
 *      through the SDK's hook system never sees the plaintext.
 *   2. process.stdout bypasses any logger configured via this SDK's
 *      `RuntimeLogger` interface. **It does NOT bypass host-level
 *      stdout capture** — runtimes like AWS Lambda, Vercel Functions,
 *      Kubernetes / container logs, systemd-journald, PM2, or a Vitest
 *      worker (see this action's own unit test) will still record the
 *      plaintext. Use this action only on hosts where stdout is a
 *      genuinely local sink (interactive terminal, local CLI run).
 *   3. The caller decides whether to invoke print-secret at all; it is
 *      not chained automatically by any other action.
 *
 * Callers MUST treat this action as the explicit "show this once" step
 * for interactive use and avoid invoking it inside server / serverless
 * runtimes whose stdout is harvested by the platform.
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
      // stdout bypasses in-SDK loggers (the action's whole purpose);
      // do not switch to a logger here. Host-level capture (Lambda,
      // k8s, PM2, Vitest worker) still applies — see JSDoc above.
      const label = input.label ? `${input.label}: ` : '';
      process.stdout.write(`${label}${input.value}\n`);
      return { printed: true };
    },
  };
}
