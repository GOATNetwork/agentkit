import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { paykitRecoveryOutput } from '../../bin/_lib/paykit-recovery-output';
import {
  FilePaymentRecoveryStore,
  paymentFingerprint,
  replayResult,
  type PaymentRecovery,
} from '../../plugins/paykit/recovery';
import { HASH, PAYER } from '../fixtures/paykit';

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, mkdir: vi.fn(fs.mkdir), open: vi.fn(fs.open), link: vi.fn(fs.link) };
});
vi.mock('node:os', async (original) => {
  const os = await original<typeof import('node:os')>();
  return { ...os, tmpdir: vi.fn(os.tmpdir) };
});
const directories: string[] = [];
afterEach(async () => {
  vi.mocked(tmpdir).mockImplementation((await vi.importActual<typeof import('node:os')>('node:os')).tmpdir);
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(fs.mkdir).mockImplementation(actual.mkdir);
  vi.mocked(fs.open).mockImplementation(actual.open);
  vi.mocked(fs.link).mockImplementation(actual.link);
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});
const receiptBody = { merchant_id: 'acme', note: 'paid' };
const receiptHeader = `${Buffer.from(JSON.stringify(receiptBody)).toString('base64url')}.signature.HS256`;
const record: PaymentRecovery = {
  kind: 'paykit',
  operationId: 'receipt',
  fingerprint: 'intent',
  rail: 'mpp',
  chainId: 4217,
  phase: 'complete',
  origin: 'https://pay.example',
  payer: PAYER,
  txHash: HASH,
  persistenceError: 'Verified receipt was not saved',
  result: { txHash: HASH, challengeId: 'ch1', receiptHeader, receiptBody },
};

describe('CLI receipt recovery output', () => {
  it.each([false, true])('skips an absent temporary parent (configured alternative: %s)', async (alternative) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'temp-unavailable-'));
    directories.push(root);
    const absent = join(root, 'absent', 'temporary');
    vi.mocked(tmpdir).mockReturnValue(absent);
    const output = await paykitRecoveryOutput(record, false, alternative ? root : undefined);
    if (alternative) expect(output.emergencyStorageWarnings).toBeUndefined();
    else expect(output.emergencyStorageWarnings).toEqual([expect.stringContaining('System temporary directory')]);
    expect(output.failedEmergencyStateDirs).toBeUndefined();
    await expect(fs.stat(join(root, 'absent'))).rejects.toMatchObject({ code: 'ENOENT' });
    if (alternative) {
      expect(dirname(String(output.emergencyStateDir))).toBe(await fs.realpath(root));
      expect(output.result).toMatchObject({ receiptHeader: '[REDACTED]' });
      expect(
        await new FilePaymentRecoveryStore(String(output.emergencyStateDir)).get(record.operationId),
      ).toMatchObject({ result: { receiptHeader } });
    } else {
      expect(output.emergencyStateDir).toBeUndefined();
      expect(output.receiptRevealedForRecovery).toBe(true);
      expect(output.result).toMatchObject({ receiptHeader });
      expect(output.recoveryHint).toContain('No emergency parent was usable');
    }
  });

  it('skips a temporary path that is a file without attempting to write below it', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'temp-file-'));
    directories.push(root);
    const file = join(root, 'file');
    await fs.writeFile(file, 'occupied');
    vi.mocked(tmpdir).mockReturnValue(file);
    const output = await paykitRecoveryOutput(record);
    expect(output.failedEmergencyStateDirs).toBeUndefined();
    expect(output.emergencyStorageWarnings).toEqual([expect.stringContaining('System temporary directory')]);
    expect(output.result).toMatchObject({ receiptHeader });
    expect(await fs.readFile(file, 'utf8')).toBe('occupied');
  });

  it.each([false, true])('recognizes a temporary-parent alias (write failure: %s)', async (fail) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'temp-alias-'));
    directories.push(root);
    const temporary = join(root, 'temporary');
    await fs.mkdir(temporary, { mode: 0o700 });
    const alias = join(root, 'alias');
    await fs.symlink(temporary, alias, 'junction');
    vi.mocked(tmpdir).mockReturnValue(alias);
    if (fail) vi.mocked(fs.mkdir).mockRejectedValue(Object.assign(new Error('full'), { code: 'ENOSPC' }));
    const output = await paykitRecoveryOutput(record, false, temporary);
    if (fail) {
      expect(output.failedEmergencyStateDirs).toHaveLength(1);
      expect(output.result).toMatchObject({ receiptHeader });
    } else {
      expect(dirname(String(output.emergencyStateDir))).toBe(await fs.realpath(temporary));
      expect(output.recoveryHint).toContain('Move the entire directory to durable private storage');
      expect(output.result).toMatchObject({ receiptHeader: '[REDACTED]' });
    }
  });

  it('omits unavailable hashes and private handles instead of printing undefined', async () => {
    const output = await paykitRecoveryOutput({ kind: 'paykit', operationId: 'prepared', phase: 'prepared' }, true);
    expect(output).toEqual({ kind: 'paykit', operationId: 'prepared', phase: 'prepared' });
  });

  it.each(['nested', 'nested-alias', 'prefix-sibling'] as const)(
    'labels configured temporary storage by directory ancestry: %s',
    async (kind) => {
      const root = await fs.mkdtemp(join(tmpdir(), 'temp-descendant-'));
      directories.push(root);
      const temporary = join(root, 'temporary');
      await fs.mkdir(temporary, { mode: 0o700 });
      const parent = kind === 'prefix-sibling' ? join(root, 'temporary-other') : join(temporary, 'private', 'nested');
      await fs.mkdir(parent, { mode: 0o700, recursive: true });
      const alias = join(root, 'alias');
      if (kind === 'nested-alias') await fs.symlink(parent, alias, 'junction');
      vi.mocked(tmpdir).mockReturnValue(temporary);
      const output = await paykitRecoveryOutput(record, false, kind === 'nested-alias' ? alias : parent);
      expect(dirname(String(output.emergencyStateDir))).toBe(await fs.realpath(parent));
      expect(String(output.recoveryHint).includes('may be lost on reboot or cleanup')).toBe(kind !== 'prefix-sibling');
      expect(output.result).toMatchObject({ receiptHeader: '[REDACTED]' });
      expect(
        await new FilePaymentRecoveryStore(String(output.emergencyStateDir)).get(record.operationId),
      ).toMatchObject({ result: { receiptHeader } });
    },
  );
  it.each([false, true])('keeps a durable private receipt even when terminal revelation is %s', async (reveal) => {
    const output = await paykitRecoveryOutput(record, reveal);
    const directory = String(output.emergencyStateDir);
    directories.push(directory);
    expect(output).toMatchObject({
      persistenceError: record.persistenceError,
      recoveryHint: expect.stringContaining('Move the entire directory to durable private storage'),
      result: { receiptHeader: reveal ? receiptHeader : '[REDACTED]' },
    });
    const saved = await new FilePaymentRecoveryStore(directory).get(record.operationId);
    expect(replayResult(saved!)).toEqual(record.result);
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(join(directory, `${paymentFingerprint(record.operationId)}.json`))).mode & 0o777).toBe(0o600);
    if (!reveal) expect(JSON.stringify(output)).not.toContain(receiptHeader);
  });

  it.each([false, true])('uses shared array field redaction for recovery results (reveal %s)', async (reveal) => {
    const item = { checkout_id: 'cs1', url: 'https://pay.example/paykit/direct?cs=cs1' };
    for (const result of [[item], { checkouts: [item] }]) {
      const output = await paykitRecoveryOutput({ ...record, rail: 'fiat', result }, reveal);
      directories.push(String(output.emergencyStateDir));
      expect(JSON.stringify(output.result).includes(item.url)).toBe(reveal);
      expect(JSON.stringify(result)).toContain(item.url);
    }
  });

  it('does not promise replay based only on the in-memory complete phase', async () => {
    const output = await paykitRecoveryOutput({ ...record, persistenceError: undefined });
    expect(output.recoveryHint).toBeUndefined();
  });

  it.each(['x402', 'fiat'] as const)(
    'saves and redacts a completed %s result when primary persistence failed',
    async (rail) => {
      const result =
        rail === 'fiat'
          ? { checkout_id: 'cs1', url: 'https://pay.example/paykit/direct?cs=cs1', currency: 'USD' }
          : { session_id: 's1', tx_hash: HASH, ok: true };
      const recovery: PaymentRecovery = { ...record, rail, result, persistenceError: 'Completion checkpoint failed' };
      for (const reveal of [false, true]) {
        const output = await paykitRecoveryOutput(recovery, reveal);
        directories.push(String(output.emergencyStateDir));
        expect(output.recoveryHint).toContain('emergency --state-dir');
        const saved = await new FilePaymentRecoveryStore(String(output.emergencyStateDir)).get(record.operationId);
        expect(saved?.result).toEqual(result);
        expect(output.result).toMatchObject(
          rail === 'fiat'
            ? { checkout_id: reveal ? 'cs1' : '[REDACTED]', url: reveal ? result.url : '[REDACTED]' }
            : { session_id: reveal ? 's1' : '[REDACTED]', tx_hash: HASH },
        );
      }
    },
  );

  it('uses a configured emergency root when the default temporary filesystem is full', async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'emergency-volume-')));
    directories.push(root);
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fs.mkdir).mockImplementation(async (path, options) => {
      if (dirname(String(path)) !== root) throw Object.assign(new Error('full'), { code: 'ENOSPC' });
      return actual.mkdir(path, options as never);
    });
    const output = await paykitRecoveryOutput(record, false, `  ${root}  `);
    expect(dirname(String(output.emergencyStateDir))).toBe(root);
    expect(output.receiptRevealedForRecovery).toBeUndefined();
    expect(output.result).toMatchObject({ receiptHeader: '[REDACTED]' });
    expect(await new FilePaymentRecoveryStore(String(output.emergencyStateDir)).get(record.operationId)).toMatchObject({
      phase: 'complete',
      result: { receiptHeader },
    });
  });

  it('falls back to temporary storage and reports the unsuccessful configured path', async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'emergency-full-')));
    directories.push(root);
    vi.mocked(fs.mkdir).mockRejectedValueOnce(Object.assign(new Error('full'), { code: 'ENOSPC' }));
    const output = await paykitRecoveryOutput(record, false, root);
    directories.push(String(output.emergencyStateDir));
    expect(dirname(String(output.emergencyStateDir))).toBe(await fs.realpath(tmpdir()));
    expect(output.failedEmergencyStateDirs).toEqual([expect.stringContaining(root)]);
    expect(output.receiptRevealedForRecovery).toBeUndefined();
  });

  it('skips an invalid configured directory without claiming that a write was attempted there', async () => {
    const primary = await fs.mkdtemp(join(tmpdir(), 'emergency-invalid-'));
    directories.push(primary);
    const output = await paykitRecoveryOutput(record, false, primary, primary);
    directories.push(String(output.emergencyStateDir));
    expect(output.emergencyStorageWarnings).toEqual([expect.stringContaining('outside the primary journal')]);
    expect(output.failedEmergencyStateDirs).toBeUndefined();
    expect(await fs.readdir(primary)).toEqual([]);
    expect(output.result).toMatchObject({ receiptHeader: '[REDACTED]' });
  });

  it('reports a partial emergency directory when completion publication fails', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fs.link).mockImplementation(async (from, to) => {
      if (String(to).endsWith('.complete.json')) throw Object.assign(new Error('full'), { code: 'ENOSPC' });
      return actual.link(from, to);
    });
    const output = await paykitRecoveryOutput(record);
    const attempted = output.failedEmergencyStateDirs as string[];
    directories.push(...attempted);
    expect(output.emergencyStateDir).toBeUndefined();
    expect(output.receiptRevealedForRecovery).toBe(true);
    expect(output.result).toMatchObject({ receiptHeader });
    expect(output.recoveryHint).toContain('durability is unconfirmed');
    expect(attempted).toHaveLength(1);
    expect(await new FilePaymentRecoveryStore(attempted[0]!).get(record.operationId)).toMatchObject({
      phase: 'complete',
      result: { receiptHeader },
    });
  });

  it('returns the sole checkout link if emergency storage also fails', async () => {
    vi.mocked(fs.mkdir).mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
    const result = { checkout_id: 'cs1', url: 'https://pay.example/paykit/direct?cs=cs1' };
    expect(await paykitRecoveryOutput({ ...record, rail: 'fiat', result })).toMatchObject({
      resultRevealedForRecovery: true,
      recoveryHint: expect.stringContaining('save it privately'),
      result,
    });
  });

  it('returns the only receipt with explicit guidance if emergency storage also fails', async () => {
    vi.mocked(fs.mkdir).mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
    expect(await paykitRecoveryOutput(record)).toMatchObject({
      persistenceError: record.persistenceError,
      receiptRevealedForRecovery: true,
      recoveryHint: expect.stringContaining('save it privately'),
      result: { receiptHeader, receiptBody },
    });
  });
});
