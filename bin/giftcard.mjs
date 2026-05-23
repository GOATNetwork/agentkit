#!/usr/bin/env node
// agentkit-giftcard — buy and manage stablecoin-paid gift cards.
//
// Thin shim with a two-mode resolution. See bin/gns.mjs for the
// detailed rationale; this file is the giftcard twin.
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPILED = resolve(HERE, '../dist/bin/_lib/cli-giftcard.js');
const TS_SOURCE = resolve(HERE, '_lib/cli-giftcard.ts');

async function loadCli() {
  if (existsSync(COMPILED)) {
    return import(pathToFileURL(COMPILED).href);
  }
  try {
    const { tsImport } = await import('tsx/esm/api');
    return tsImport(pathToFileURL(TS_SOURCE).href, import.meta.url);
  } catch (err) {
    process.stderr.write(
      `agentkit-giftcard: missing compiled CLI at ${COMPILED}, and the tsx\n` +
        `dev fallback is unavailable: ${err instanceof Error ? err.message : String(err)}\n` +
        `(if running from a source checkout, run \`pnpm build\` first)\n`,
    );
    process.exit(99);
  }
}

async function main() {
  const mod = await loadCli();
  const exit = await mod.runGiftcardCli(process.argv);
  process.exit(typeof exit === 'number' ? exit : 0);
}

main().catch((err) => {
  process.stderr.write((err instanceof Error ? err.stack ?? err.message : String(err)) + '\n');
  process.exit(99);
});
