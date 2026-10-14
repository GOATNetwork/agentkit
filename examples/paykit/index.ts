import { randomUUID } from 'node:crypto';
import { PaykitService, createPaykitActions } from '../../plugins/paykit';
import { ActionProvider } from '../../providers/action-provider';
import { PolicyEngine } from '../../core/policy/policy-engine';
import { ExecutionRuntime } from '../../core/runtime/execution-runtime';

// Read-only discovery: pnpm example:paykit https://.../paykit/<merchant>
const url = process.argv[2];
if (!url) throw new Error('Usage: pnpm example:paykit <trusted merchant PayKit URL>');
const provider = new ActionProvider();
for (const action of createPaykitActions(new PaykitService())) provider.register(action);
const runtime = new ExecutionRuntime(
  new PolicyEngine({
    allowedNetworks: ['paykit'],
    maxRiskWithoutConfirm: 'read',
    writeEnabled: false,
  }),
);
const result = await runtime.run(
  provider.get('goat.paykit.inspect'),
  {
    traceId: randomUUID(),
    network: 'paykit',
    now: Date.now(),
  },
  { url },
);
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
