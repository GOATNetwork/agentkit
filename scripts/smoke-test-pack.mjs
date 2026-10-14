#!/usr/bin/env node
/**
 * scripts/smoke-test-pack.mjs
 *
 * Catch the class of bugs that the source-tree test suite cannot see:
 * "does the published tarball actually run?"
 *
 *   1. `pnpm pack` the current working tree.
 *   2. Extract the tarball into a fresh temp directory.
 *   3. Install runtime dependencies into that directory.
 *   4. `node -e "import('./dist/index.js')"` — verifies the ESM
 *      barrel resolves (catches missing `.js` extensions from
 *      `moduleResolution: Bundler`).
 *   5. `node bin/gns.mjs --help` and `node bin/giftcard.mjs --help`
 *      — verifies the CLIs find their compiled `dist/bin/_lib/`
 *      counterparts and don't depend on un-shipped source paths.
 *
 * Exits 0 on success, non-zero on the first failure. Intended to be
 * run locally before `npm publish` and (eventually) in CI.
 *
 * Run: `pnpm pack:smoke` or `node scripts/smoke-test-pack.mjs`.
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

function run(cmd, args, opts = {}) {
  process.stdout.write(`$ ${cmd} ${args.join(' ')}\n`);
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (res.status !== 0) {
    process.stderr.write(`smoke-test-pack: \`${cmd} ${args.join(' ')}\` failed (status ${res.status})\n`);
    process.exit(res.status ?? 99);
  }
  return res;
}

const TMP = mkdtempSync(join(tmpdir(), 'agentkit-smoke-'));
process.stdout.write(`smoke-test-pack: scratch dir ${TMP}\n`);

let exitCode = 0;
try {
  // 1. pack
  run('pnpm', ['pack', '--pack-destination', TMP], { cwd: ROOT });
  const tarballs = readdirSync(TMP).filter((f) => f.endsWith('.tgz'));
  if (tarballs.length !== 1) {
    throw new Error(`expected exactly one .tgz in ${TMP}, found ${tarballs.length}`);
  }
  const tarball = join(TMP, tarballs[0]);
  process.stdout.write(`smoke-test-pack: tarball=${tarball}\n`);

  // 2. set up an isolated install root and install the tarball there.
  const INSTALL_ROOT = join(TMP, 'consumer');
  run('mkdir', ['-p', INSTALL_ROOT]);
  writeFileSync(
    join(INSTALL_ROOT, 'package.json'),
    JSON.stringify({ name: 'agentkit-smoke', private: true, version: '0.0.0', type: 'module' }, null, 2),
  );
  // `npm install` produces a real node_modules tree from the local
  // tarball, which is what we actually want to exercise.
  run('npm', ['install', '--no-audit', '--no-fund', '--silent', tarball], { cwd: INSTALL_ROOT });

  const pkgDir = join(INSTALL_ROOT, 'node_modules', '@goatnetwork', 'agentkit');

  // 3. ESM barrel resolves under plain Node?
  run(
    'node',
    [
      '-e',
      `import('@goatnetwork/agentkit').then((m) => { if (typeof m.ExecutionRuntime !== 'function' || typeof m.PaykitService !== 'function' || typeof m.GoatFlowGatewayAdapter !== 'function') { console.error('missing ExecutionRuntime'); process.exit(1); } process.stdout.write('barrel-ok\\n'); }).catch((e) => { console.error('barrel-fail', e); process.exit(1); });`,
    ],
    { cwd: INSTALL_ROOT },
  );

  // 4. Bin help — both CLIs must produce non-empty output, exit 0.
  const gnsBin = join(pkgDir, 'bin', 'gns.mjs');
  const giftcardBin = join(pkgDir, 'bin', 'giftcard.mjs');
  run('node', [gnsBin, '--help'], { cwd: INSTALL_ROOT });
  run('node', [giftcardBin, '--help'], { cwd: INSTALL_ROOT });

  run('node', [join(pkgDir, 'bin', 'paykit.mjs'), '--help'], { cwd: INSTALL_ROOT });

  // 5. Confirm tsx is NOT shipped as a runtime dependency.
  const pkgJson = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  if (pkgJson.dependencies?.tsx) {
    throw new Error(`tsx must not be a runtime dependency, found: ${pkgJson.dependencies.tsx}`);
  }

  process.stdout.write('smoke-test-pack: PASS\n');
} catch (err) {
  process.stderr.write(`smoke-test-pack: FAIL — ${err instanceof Error ? err.message : String(err)}\n`);
  exitCode = 1;
} finally {
  // Best-effort cleanup. Keep on failure so the user can inspect.
  if (exitCode === 0) {
    try {
      rmSync(TMP, { recursive: true, force: true });
    } catch {
      // ignore
    }
  } else {
    process.stderr.write(`smoke-test-pack: leaving ${TMP} for inspection\n`);
  }
  process.exit(exitCode);
}
