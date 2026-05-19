#!/usr/bin/env node
// agentkit-gns — manage .goat names on the GOAT Name Service.
//
// This file is intentionally a tiny shim: it registers the tsx ESM
// loader so we can write CLI internals as TypeScript modules under
// bin/_lib/, then delegates to runGnsCli().
import { tsImport } from 'tsx/esm/api';

async function main() {
  const mod = await tsImport('./_lib/cli-gns.ts', import.meta.url);
  const exit = await mod.runGnsCli(process.argv);
  process.exit(typeof exit === 'number' ? exit : 0);
}

main().catch((err) => {
  // Catastrophic failure: tsx couldn't load, top-level throw, etc.
  // Map to exit 99 per Phase G spec for "unknown".
  process.stderr.write((err instanceof Error ? err.stack ?? err.message : String(err)) + '\n');
  process.exit(99);
});
