#!/usr/bin/env node
// agentkit-paykit — GOAT Flow payments and recovery.
//
// Thin shim with a two-mode resolution. See bin/gns.mjs for the
// detailed rationale; this file is the paykit twin.
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPILED = resolve(HERE, '../dist/bin/_lib/cli-paykit.js');
const TS_SOURCE = resolve(HERE, '_lib/cli-paykit.ts');

async function loadCli() {
  try {
    if (existsSync(COMPILED)) {
      return await import(pathToFileURL(COMPILED).href);
    }
    const { tsImport } = await import('tsx/esm/api');
    return await tsImport(pathToFileURL(TS_SOURCE).href, import.meta.url);
  } catch (err) {
    // Startup happens before wallet/network execution. Expose import diagnostics,
    // but never dump runtime payment errors or authenticated response bodies.
    const code = typeof err?.code === 'string' && /^[A-Z_]+$/.test(err.code) ? ` (${err.code})` : '';
    const detail =
      err instanceof Error ? err.message.replace(/[\r\n\x1b]/g, ' ').slice(0, 1000) : 'unknown module error';
    process.stderr.write(
      `agentkit-paykit: CLI module failed to load${code}: ${detail}\n` +
        `Reinstall dependencies or run \`pnpm build\` in a source checkout.\n`,
    );
    process.exit(99);
  }
}

async function main() {
  const mod = await loadCli();
  const exit = await mod.runPaykitCli(process.argv);
  process.exit(typeof exit === 'number' ? exit : 0);
}

main().catch((err) => {
  const code = typeof err?.code === 'string' && /^[A-Z_]+$/.test(err.code) ? ` (${err.code})` : '';
  process.stderr.write(`PayKit CLI failed${code}; inspect the private journal before retrying\n`);
  process.exit(99);
});
