#!/usr/bin/env node
/**
 * scripts/sync-skill-manifests.mjs
 *
 * Codegen step (Phase G ↔ Phase H bridge). Reads the structured
 * CLI metadata modules at bin/_lib/commands/<cli>/metadata.ts and
 * writes machine-readable stubs at dist-manifests/<cli>.manifest.json.
 *
 * The output is consumed by PR #5 (`@goatnetwork/skill-*` bundles) to
 * generate their own `manifest.json.scripts[]` entries. This script's
 * job here in PR #4 is to RUN cleanly and produce a deterministic
 * file — full schema validation comes with PR #5.
 *
 * Run via: `pnpm sync:skill-manifests` (or `node scripts/sync-skill-manifests.mjs`).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT_DIR = resolve(ROOT, 'dist-manifests');

async function loadMetadata(relPath, exportName) {
  const mod = await tsImport(relPath, import.meta.url);
  if (!mod[exportName]) {
    throw new Error(`metadata module ${relPath} has no export ${exportName}`);
  }
  return mod[exportName];
}

function buildManifestStub(meta) {
  return {
    bin: meta.bin,
    summary: meta.summary,
    subcommands: meta.subcommands.map((sub) => ({
      name: sub.name,
      summary: sub.summary,
      description: sub.description,
      args: sub.args ?? [],
      flags: sub.flags ?? [],
      actions: sub.actions ?? [],
      risk: sub.risk,
    })),
  };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const gns = await loadMetadata('../bin/_lib/commands/gns/metadata.ts', 'GNS_CLI_METADATA');
  const giftcard = await loadMetadata('../bin/_lib/commands/giftcard/metadata.ts', 'GIFTCARD_CLI_METADATA');

  const targets = [
    { name: 'gns', meta: gns },
    { name: 'giftcard', meta: giftcard },
  ];

  for (const { name, meta } of targets) {
    const stub = buildManifestStub(meta);
    const outPath = resolve(OUT_DIR, `${name}.manifest.json`);
    writeFileSync(outPath, JSON.stringify(stub, null, 2) + '\n', 'utf8');
    process.stdout.write(`wrote ${outPath}\n`);
  }
}

main().catch((err) => {
  process.stderr.write((err instanceof Error ? err.stack ?? err.message : String(err)) + '\n');
  process.exit(1);
});
