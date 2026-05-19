#!/usr/bin/env node
// agentkit-giftcard — buy and manage stablecoin-paid gift cards.
//
// Thin shim that registers the tsx ESM loader and delegates to the TS
// CLI implementation under bin/_lib/cli-giftcard.ts.
import { tsImport } from 'tsx/esm/api';

async function main() {
  const mod = await tsImport('./_lib/cli-giftcard.ts', import.meta.url);
  const exit = await mod.runGiftcardCli(process.argv);
  process.exit(typeof exit === 'number' ? exit : 0);
}

main().catch((err) => {
  process.stderr.write((err instanceof Error ? err.stack ?? err.message : String(err)) + '\n');
  process.exit(99);
});
