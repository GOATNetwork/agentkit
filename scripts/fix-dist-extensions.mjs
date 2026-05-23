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
import ts from 'typescript';

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

/**
 * Locate the RAW specifier text span (between the quotes, exclusive of
 * them) for a `preProcessFile` reference. `ref.pos` is the opening quote;
 * we scan forward for the matching closing quote, honouring backslash
 * escapes, and return `[contentStart, contentEnd)` over the original
 * source.
 *
 * Why not trust `ref.pos`/`ref.end` arithmetic: `ref.end === ref.pos +
 * fileName.length`, but `ref.fileName` is the DECODED specifier. When the
 * source spells the specifier with an escape (`'./foo/bar'`,
 * `'./fo\'o'`) the raw text is longer than the decoded name, so any
 * `pos`/`end` + offset math slices through the middle of the literal and
 * corrupts it. Scanning for the real closing quote is escape-safe.
 * Returns null if `ref.pos` is not a quote (defensive — skip rather than
 * risk a bad edit).
 */
function specifierContentRange(src, ref) {
  const quote = src[ref.pos];
  if (quote !== '"' && quote !== "'") return null;
  for (let i = ref.pos + 1; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      i++; // skip the escaped char
      continue;
    }
    if (c === quote) return { start: ref.pos + 1, end: i };
  }
  return null;
}

/**
 * Find every module-specifier span using the real TypeScript lexer
 * (`ts.preProcessFile`) instead of a raw-text regex. `importedFiles`
 * covers static `import`/`export ... from`, side-effect `import '...'`,
 * dynamic `import('...')`, and inline `import("...")` type references in
 * `.d.ts`. Because this is a true lexer pass, a `from './x'` or
 * `import('./x')` sitting inside a string literal or comment is NOT
 * mistaken for an import — fixing the false-positive corruption the old
 * whole-file regex was prone to. (`referencedFiles` / triple-slash refs
 * are intentionally ignored — they are not relative ESM specifiers we
 * need to extend.)
 */
function patchFile(file) {
  const src = readFileSync(file, 'utf8');
  const info = ts.preProcessFile(src, /* readImportFiles */ true, /* detectJavaScriptImports */ true);
  const edits = [];
  for (const ref of info.importedFiles) {
    const replaced = resolveSpecifier(ref.fileName, file);
    if (replaced == null || replaced === ref.fileName) continue;
    const range = specifierContentRange(src, ref);
    if (!range) continue;
    // `resolveSpecifier` always returns `ref.fileName` + a resolved
    // suffix (".js", "/index.js", or "index.js"). Insert ONLY that suffix
    // right before the closing quote and leave the RAW specifier text
    // untouched, so backslash escapes in the source literal (e.g.
    // `'./fo\'o'`) survive — a decoded full-span replacement would emit
    // an unescaped quote and break the literal. Defensive fallback to a
    // full replace if the invariant ever fails to hold.
    if (replaced.startsWith(ref.fileName)) {
      edits.push({ pos: range.end, end: range.end, text: replaced.slice(ref.fileName.length) });
    } else {
      edits.push({ pos: range.start, end: range.end, text: replaced });
    }
  }
  if (!edits.length) return false;
  // Apply right-to-left so earlier edits don't shift later offsets.
  edits.sort((a, b) => b.pos - a.pos);
  let out = src;
  for (const e of edits) {
    out = out.slice(0, e.pos) + e.text + out.slice(e.end);
  }
  writeFileSync(file, out);
  return true;
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
