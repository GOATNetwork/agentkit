import { access, realpath, stat } from 'node:fs/promises';
import { constants, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep, basename } from 'node:path';
import { AgentkitRuntimeError } from '../../core/errors/error';
import { ErrorCodes } from '../../core/errors/error-codes';

/** Resolve symlinked ancestors even when the primary journal has not been created. */
async function canonicalLocation(value: string) {
  let path = resolve(value.trim());
  const suffix: string[] = [];
  for (;;) {
    try {
      const canonical = await realpath(path);
      return { path: join(canonical, ...suffix), stats: await stat(canonical) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error;
      suffix.unshift(basename(path));
      path = dirname(path);
    }
  }
}

/** Component-aware containment for canonical directory paths (including equality). */
export function containsDirectory(parent: string, child: string) {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/** Read-only scaffold; callers choose path normalization and ownership rules. */
async function accessibleDirectory(value: string, checkPermissions: (stats: Stats) => void) {
  if (!value.trim()) throw new Error('Empty directory');
  const directory = await realpath(resolve(value));
  const stats = await stat(directory);
  if (!stats.isDirectory()) throw new Error('Not a directory');
  if (process.platform !== 'win32') checkPermissions(stats);
  await access(directory, constants.R_OK | constants.W_OK | constants.X_OK);
  return { directory, stats };
}

/** System temp parents may be shared, but must already exist and protect children. */
export async function validateTemporaryDirectory(value: string): Promise<string> {
  try {
    const { directory } = await accessibleDirectory(value, (stats) => {
      if (
        (stats.uid !== process.getuid?.() && stats.uid !== 0) ||
        ((stats.mode & 0o022) !== 0 && (stats.mode & 0o1000) === 0)
      )
        throw new Error('Unsafe temporary parent ownership or permissions');
    });
    return directory;
  } catch (cause) {
    throw new AgentkitRuntimeError(
      ErrorCodes.INVALID_INPUT,
      'System temporary directory is unavailable or unsafe; it must already exist and be accessible, with trusted ownership and sticky permissions if shared',
      cause,
    );
  }
}

/** Read-only preflight for an explicitly configured emergency parent. */
export async function validateEmergencyDirectory(value: string, primaryDirectory?: string) {
  try {
    const { directory, stats } = await accessibleDirectory(value.trim(), (stats) => {
      if ((stats.mode & 0o077) !== 0 || stats.uid !== process.getuid?.())
        throw new AgentkitRuntimeError(
          ErrorCodes.INVALID_INPUT,
          'Emergency directory must be owned by the current user and private (mode 0700)',
        );
    });
    const warnings: string[] = [];
    if (primaryDirectory !== undefined) {
      const primary = await canonicalLocation(primaryDirectory).catch((cause: unknown) => {
        throw new AgentkitRuntimeError(
          ErrorCodes.INVALID_INPUT,
          'Primary state directory cannot be resolved; check --state-dir and its ancestors',
          cause,
        );
      });
      if (!primary.stats.isDirectory())
        throw new AgentkitRuntimeError(ErrorCodes.INVALID_INPUT, 'Primary state directory must be a directory');
      if (containsDirectory(primary.path, directory))
        throw new AgentkitRuntimeError(
          ErrorCodes.INVALID_INPUT,
          'Emergency directory must be outside the primary journal, not equal to it or nested inside it',
        );
      if (primary.stats.dev === stats.dev)
        warnings.push(
          'Emergency directory shares the primary journal filesystem; it does not protect against that filesystem running out of space.',
        );
    }
    return { directory, warnings };
  } catch (cause) {
    if (cause instanceof AgentkitRuntimeError) throw cause;
    throw new AgentkitRuntimeError(
      ErrorCodes.INVALID_INPUT,
      'Emergency directory must already exist and be an accessible private directory',
      cause,
    );
  }
}
