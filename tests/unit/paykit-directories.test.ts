import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join, parse, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  containsDirectory,
  validateEmergencyDirectory,
  validateTemporaryDirectory,
} from '../../bin/_lib/paykit-directories';

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, realpath: vi.fn(fs.realpath), stat: vi.fn(fs.stat) };
});
const directories: string[] = [];
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'paykit-dirs-'));
  directories.push(root);
  const primary = join(root, 'primary');
  const emergency = join(root, 'emergency');
  await mkdir(primary, { mode: 0o700 });
  await mkdir(emergency, { mode: 0o700 });
  return { root, primary, emergency };
}
afterEach(async () => {
  vi.mocked(stat).mockImplementation(
    (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).stat,
  );
  vi.mocked(realpath).mockImplementation(
    (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).realpath,
  );
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('emergency directory preflight', () => {
  it('compares directory components, including equality, descendants and filesystem roots', () => {
    const parent = resolve('directory-containment');
    expect(containsDirectory(parent, parent)).toBe(true);
    expect(containsDirectory(parent, join(parent, 'private', 'recovery'))).toBe(true);
    expect(containsDirectory(parent, `${parent}-sibling`)).toBe(false);
    expect(containsDirectory(join(parent, 'child'), parent)).toBe(false);
    expect(containsDirectory(parse(parent).root, parent)).toBe(true);
    if (process.platform === 'win32') expect(containsDirectory('C:\\state', 'D:\\state')).toBe(false);
  });
  it.skipIf(process.platform === 'win32')('accepts a root-owned sticky system temporary parent', async () => {
    const { emergency } = await setup();
    const stats = await stat(emergency);
    vi.mocked(stat).mockResolvedValue(Object.assign(stats, { uid: 0, mode: 0o41777 }));
    expect(await validateTemporaryDirectory(emergency)).toBe(await realpath(emergency));
    await expect(validateEmergencyDirectory(emergency)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a temporary parent owned by another user even with sticky protection',
    async () => {
      const { emergency } = await setup();
      const stats = await stat(emergency);
      vi.mocked(stat).mockResolvedValue(Object.assign(stats, { uid: (process.getuid!() || 1) + 1, mode: 0o41777 }));
      await expect(validateTemporaryDirectory(emergency)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    },
  );

  it('identifies a primary path that is itself a regular file', async () => {
    const { root, emergency } = await setup();
    const primary = join(root, 'primary-file');
    await writeFile(primary, 'occupied');
    await expect(validateEmergencyDirectory(emergency, primary)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: 'Primary state directory must be a directory',
    });
  });

  it.skipIf(process.platform === 'win32')('requires sticky protection for shared temporary parents', async () => {
    const { emergency } = await setup();
    await chmod(emergency, 0o777);
    await expect(validateTemporaryDirectory(emergency)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await chmod(emergency, 0o1777);
    expect(await validateTemporaryDirectory(emergency)).toBe(await realpath(emergency));
  });

  it.each(['ENOTDIR', 'EACCES', 'ELOOP'])('identifies a primary path failure (%s) correctly', async (code) => {
    const { root, emergency } = await setup();
    const file = join(root, 'file');
    await writeFile(file, 'occupied');
    const primary = join(file, 'journal');
    // ENOTDIR is exercised on disk; inject the permission/loop variants to
    // keep the diagnostic check portable across privileged test environments.
    if (code !== 'ENOTDIR') {
      const actual = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).realpath;
      vi.mocked(realpath).mockImplementation(async (path, options) => {
        if (path === primary) throw Object.assign(new Error('unavailable'), { code });
        return actual(path, options as never);
      });
    }
    await expect(validateEmergencyDirectory(emergency, primary)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('Primary state directory'),
      cause: { code },
    });
  });

  it('normalizes paths and reports shared filesystem capacity', async () => {
    const { primary, emergency } = await setup();
    const result = await validateEmergencyDirectory(` \t${emergency} \n`, ` ${primary} `);
    expect(result.directory).toBe(await realpath(emergency));
    expect(result.warnings).toEqual([
      expect.stringContaining('does not protect against that filesystem running out of space'),
    ]);
  });

  it.each(['same', 'child', 'symlink'] as const)('rejects %s overlap with the primary journal', async (kind) => {
    const { root, primary } = await setup();
    let emergency = primary;
    if (kind === 'child') {
      emergency = join(primary, 'emergency');
      await mkdir(emergency, { mode: 0o700 });
    } else if (kind === 'symlink') {
      emergency = join(root, 'alias');
      await symlink(primary, emergency, 'junction');
    }
    await expect(validateEmergencyDirectory(emergency, primary)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('outside the primary journal'),
    });
  });

  it('resolves aliases of not-yet-created primary directories without blocking a sibling emergency copy', async () => {
    const { root, emergency } = await setup();
    const alias = join(root, 'alias');
    await symlink(emergency, alias, 'junction');
    const result = await validateEmergencyDirectory(emergency, join(alias, 'future-primary'));
    expect(result.warnings).toEqual([expect.stringContaining('shares the primary journal filesystem')]);
  });

  it.each(['absent', 'file', 'blank'] as const)('rejects an unusable %s parent', async (kind) => {
    const { root, primary } = await setup();
    const path = kind === 'blank' ? '  ' : join(root, 'not-a-directory');
    if (kind === 'file') await writeFile(path, 'occupied');
    await expect(validateEmergencyDirectory(path, primary)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it.skipIf(process.platform === 'win32')('rejects a configured parent shared with other users', async () => {
    const { primary, emergency } = await setup();
    await chmod(emergency, 0o755);
    await expect(validateEmergencyDirectory(emergency, primary)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('private (mode 0700)'),
    });
  });
});
