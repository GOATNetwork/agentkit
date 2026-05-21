#!/usr/bin/env node
/**
 * scripts/fix-dist-extensions.mjs
 *
 * Post-`tsc` step that walks `dist/` and rewrites extensionless
 * relative specifiers so the emitted ESM is runnable under plain Node.
 *
 * The tsconfig uses `"moduleResolution": "Bundler"` for the source-side
 * DX (no `.js` in TS imports), which causes tsc to emit imports
 * verbatim: `from './core/index'` instead of `from './core/index.js'`.
 * Plain Node ESM refuses those — `node -e "import('./dist/index.js')"`
 * fails with `ERR_MODULE_NOT_FOUND`. We patch the emitted output
 * rather than mutating every source file by hand (the codebase has
 * 350+ relative imports).
 *
 * What we rewrite:
 *   1. Static imports / exports / re-exports: matches the
 *      `from '<relative>'` clause on `import`, `import type`,
 *      `export ... from`, and `export *` statements.
 *   2. Dynamic imports: `import('<relative>')`.
 *   3. Inline `.d.ts` type references: `import("<relative>")` inside
 *      type positions.
 *
 * What gets appended:
 *   - If `<relative>` resolves to a file `<X>.js`, we rewrite to
 *     `<X>.js`.
 *   - If it resolves to a directory containing `index.js`, we rewrite
 *     to `<X>/index.js`.
 *   - If the original specifier already ends in `.js`, `.mjs`,
 *     `.cjs`, `.json`, `.css`, etc., we leave it alone.
 *   - Bare specifiers (`from 'zod'`, `from 'viem'`) and absolute paths
 *     are left alone.
 *
 * Run via: `pnpm build` (chained after tsc) or
 * `node scripts/fix-dist-extensions.mjs <dist-dir>`.
 */
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DIST = process.argv[2] ? resolve(process.argv[2]) : resolve(ROOT, 'dist');

if (!existsSync(DIST)) {
  console.error(`fix-dist-extensions: dist directory not found at ${DIST}`);
  process.exit(1);
}

/** Specifier already has a recognised file extension — leave it. */
const ALREADY_RESOLVED_EXT = /\.(?:js|mjs|cjs|json|css|wasm)$/;

/**
 * Given a relative specifier and the file it appears in, return the
 * specifier with the appropriate extension appended, or null if no
 * change is needed.
 */
function resolveSpecifier(spec, fromFile) {
  if (!spec.startsWith('.')) return null; // bare package
  if (ALREADY_RESOLVED_EXT.test(spec)) return null; // already extended
  const fromDir = dirname(fromFile);
  const target = resolve(fromDir, spec);

  // Case 1: <target>.js is a real file.
  if (existsSync(`${target}.js`)) return `${spec}.js`;
  // Case 2: target is a directory with index.js.
  try {
    const s = statSync(target);
    if (s.isDirectory() && existsSync(join(target, 'index.js'))) {
      return spec.endsWith('/') ? `${spec}index.js` : `${spec}/index.js`;
    }
  } catch {
    // not a directory — fall through
  }
  // Case 3: <target>.d.ts (for .d.ts file processing). Most .d.ts type
  // references resolve to a sibling .js, so case 1 above covers them.
  // If neither file nor dir/index exists, leave as-is and let Node
  // surface the error at import time.
  if (existsSync(`${target}.d.ts`)) return `${spec}.js`;
  return null;
}

// Combined regex: captures `from '...'` and `import('...')` forms.
// Group 1 (`from` form) or 2 (`import()` form) holds the specifier.
const SPEC_REGEX = /(?:from\s*['"])([^'"]+)(?=['"])|(?:import\s*\(\s*['"])([^'"]+)(?=['"]\s*\))/g;

function patchFile(file) {
  const src = readFileSync(file, 'utf8');
  let mutated = false;
  const out = src.replace(SPEC_REGEX, (match, fromSpec, importSpec) => {
    const spec = fromSpec ?? importSpec;
    const replaced = resolveSpecifier(spec, file);
    if (replaced == null) return match;
    mutated = true;
    return match.slice(0, match.length - spec.length) + replaced;
  });
  if (mutated) writeFileSync(file, out);
  return mutated;
}

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (entry.isFile() && /\.(?:js|d\.ts|mjs)$/.test(entry.name)) {
      const changed = patchFile(full);
      if (changed && process.env.FIX_DIST_VERBOSE) {
        process.stdout.write(`patched ${full.slice(ROOT.length + 1)}\n`);
      }
    }
  }
}

walk(DIST);
process.stdout.write(`fix-dist-extensions: walked ${DIST}\n`);
