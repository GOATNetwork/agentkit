#!/usr/bin/env node
// agentkit-gns — manage .goat names on the GOAT Name Service.
//
// Thin shim with a two-mode resolution:
//
//   1. PUBLISHED PACKAGE — `dist/bin/_lib/cli-gns.js` is present (tsc
//      shipped it). Plain ESM `import()` of the compiled JS. No tsx
//      at runtime; the npm package does not ship tsx as a runtime dep.
//
//   2. SOURCE CHECKOUT pre-`pnpm build` — `dist/` does not exist yet.
//      Fall back to `tsx/esm/api` to transform the TypeScript source
//      directly. This path is only reachable in a dev environment
//      where tsx is installed as a devDependency. If neither path is
//      available, exit 99 with a clear pointer.
//
// The integration tests at tests/integration/cli-gns.test.ts spawn
// this shim against the source tree without running `pnpm build`
// first, so the fallback is load-bearing for the test suite.
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPILED = resolve(HERE, '../dist/bin/_lib/cli-gns.js');
const TS_SOURCE = resolve(HERE, '_lib/cli-gns.ts');

async function loadCli() {
  if (existsSync(COMPILED)) {
    return import(pathToFileURL(COMPILED).href);
  }
  // Dev fallback. Importing 'tsx/esm/api' will throw if tsx is not
  // installed (i.e. we're in a published consumer install with no
  // devDependencies AND somehow `dist/` is missing). In that case we
  // surface the clear "run pnpm build first" hint rather than the
  // raw module-not-found.
  try {
    const { tsImport } = await import('tsx/esm/api');
    return tsImport(pathToFileURL(TS_SOURCE).href, import.meta.url);
  } catch (err) {
    process.stderr.write(
      `agentkit-gns: missing compiled CLI at ${COMPILED}, and the tsx\n` +
        `dev fallback is unavailable: ${err instanceof Error ? err.message : String(err)}\n` +
        `(if running from a source checkout, run \`pnpm build\` first)\n`,
    );
    process.exit(99);
  }
}

async function main() {
  const mod = await loadCli();
  const exit = await mod.runGnsCli(process.argv);
  process.exit(typeof exit === 'number' ? exit : 0);
}

main().catch((err) => {
  // Catastrophic failure: top-level throw, import error etc. Map to
  // exit 99 per the Phase G spec for "unknown".
  process.stderr.write((err instanceof Error ? err.stack ?? err.message : String(err)) + '\n');
  process.exit(99);
});
