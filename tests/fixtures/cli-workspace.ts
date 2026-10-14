import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(import.meta.url);
const exec = promisify(execFile);

/** Suite-owned checkout: no writes to shared dist, dependency installation or package-manager subprocesses. */
export async function createCliWorkspace(compiled = false) {
  const root = await mkdtemp(join(tmpdir(), 'agentkit-cli-workspace-'));
  const dispose = () => rm(root, { recursive: true, force: true });
  try {
    await cp(join(repo, 'package.json'), join(root, 'package.json'));
    await cp(join(repo, 'bin'), join(root, 'bin'), { recursive: true });
    // Windows junctions work without the privilege required for directory symlinks.
    await symlink(join(repo, 'node_modules'), join(root, 'node_modules'), 'junction');
    if (compiled) {
      const dist = join(root, 'dist');
      await exec(
        process.execPath,
        [
          require.resolve('typescript/bin/tsc'),
          '-p',
          join(repo, 'tsconfig.json'),
          '--outDir',
          dist,
          '--declaration',
          'false',
        ],
        { cwd: repo, maxBuffer: 4 * 1024 * 1024 },
      );
      await exec(process.execPath, [join(repo, 'scripts/fix-dist-extensions.mjs'), dist], { cwd: repo });
      await mkdir(join(root, 'tests/fixtures'), { recursive: true });
      await cp(
        join(repo, 'tests/fixtures/paykit-delayed-broadcast.mjs'),
        join(root, 'tests/fixtures/paykit-delayed-broadcast.mjs'),
      );
    } else {
      // Copy source rather than symlinking it: Node realpaths must not lead back
      // to a shared checkout, and this workspace must have no compiled fallback.
      await Promise.all(
        ['core', 'plugins', 'networks', 'providers', 'adapters'].map((dir) =>
          cp(join(repo, dir), join(root, dir), { recursive: true }),
        ),
      );
      await cp(join(repo, 'tsconfig.json'), join(root, 'tsconfig.json'));
      await cp(join(repo, 'index.ts'), join(root, 'index.ts'));
    }
    return { root, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
