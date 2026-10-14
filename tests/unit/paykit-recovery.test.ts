import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  FilePaymentRecoveryStore,
  InMemoryPaymentRecoveryStore,
  paymentFingerprint,
  type PaymentRecovery,
} from '../../plugins/paykit/recovery';

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, open: vi.fn(fs.open), rename: vi.fn(fs.rename), link: vi.fn(fs.link) };
});

const record: PaymentRecovery = {
  kind: 'paykit',
  operationId: 'invoice',
  fingerprint: 'intent',
  rail: 'x402',
  chainId: 4217,
  phase: 'prepared',
  origin: 'https://pay.example',
};
const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
async function temp() {
  const path = await fs.mkdtemp(join(tmpdir(), 'paykit-recovery-'));
  directories.push(path);
  return path;
}

describe('payment recovery persistence', () => {
  it('normalizes surrounding whitespace before resolving journal directories', async () => {
    const directory = await temp();
    await new FilePaymentRecoveryStore(`  ${directory} \n`).claim(record);
    expect(await new FilePaymentRecoveryStore(directory).get(record.operationId)).toEqual(record);
  });

  it('compacts completed snapshots without promising erasure of the older file checkpoint', async () => {
    const directory = await temp();
    const store = new FilePaymentRecoveryStore(directory);
    const request = {
      ...record,
      phase: 'requesting' as const,
      sessionCreateBody: JSON.stringify({ token_contract: `0x${'11'.repeat(20)}`, memo: 'private original request' }),
    };
    await store.claim(request);
    await store.put({ ...request, phase: 'complete', result: { ok: true } });
    expect((await store.get(record.operationId))?.sessionCreateBody).toBeUndefined();
    const original = JSON.parse(
      await fs.readFile(join(directory, `${paymentFingerprint(record.operationId)}.json`), 'utf8'),
    );
    expect(original.sessionCreateBody).toBe(request.sessionCreateBody);
    const completed = JSON.parse(
      await fs.readFile(join(directory, `${paymentFingerprint(record.operationId)}.complete.json`), 'utf8'),
    );
    expect(completed.sessionCreateBody).toBeUndefined();
  });
  it.each(['', '   '])('rejects a blank directory instead of writing into cwd (%j)', (directory) => {
    expect(() => new FilePaymentRecoveryStore(directory)).toThrow('Payment journal directory must not be empty');
  });
  it.each(['memory', 'file'] as const)('preserves the first completion against stale %s puts', async (kind) => {
    const directory = await temp();
    const memory = new InMemoryPaymentRecoveryStore();
    const store = () => (kind === 'memory' ? memory : new FilePaymentRecoveryStore(directory));
    await store().claim(record);
    const complete = { ...record, phase: 'complete' as const, result: { receiptHeader: 'saved' } };
    await store().put(complete);
    expect(await store().put({ ...record, phase: 'broadcast' })).toEqual(complete);
    await store().put({ ...complete, result: { receiptHeader: 'different' } });
    expect(await store().get(record.operationId)).toEqual(complete);
    expect(await store().claim(record)).toBe(false);
    await expect(store().put({ ...record, fingerprint: 'another-intent' })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });

  it('cannot erase completion with a checkpoint rename already in flight in another store', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const directory = await temp();
    const stale = new FilePaymentRecoveryStore(directory);
    await stale.claim(record);
    let started!: () => void;
    let finish!: () => void;
    const entered = new Promise<void>((r) => {
      started = r;
    });
    const pending = new Promise<void>((r) => {
      finish = r;
    });
    vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {
      started();
      await pending;
      return actual.rename(from, to);
    });
    try {
      const write = stale.put({ ...record, phase: 'broadcast' });
      await entered;
      const complete = { ...record, phase: 'complete' as const, result: { receiptHeader: 'preserved' } };
      await new FilePaymentRecoveryStore(directory).put(complete);
      finish();
      expect(await write).toEqual(complete);
      expect(await new FilePaymentRecoveryStore(directory).get(record.operationId)).toEqual(complete);
    } finally {
      finish();
      vi.mocked(fs.rename).mockImplementation(actual.rename);
    }
  });

  it('preserves completed records from the legacy single-file journal format', async () => {
    const directory = await temp();
    const complete = { ...record, phase: 'complete' as const, result: { receiptHeader: 'legacy' } };
    await fs.writeFile(join(directory, `${paymentFingerprint(record.operationId)}.json`), JSON.stringify(complete));
    await new FilePaymentRecoveryStore(directory).put({ ...record, phase: 'broadcast' });
    expect(await new FilePaymentRecoveryStore(directory).get(record.operationId)).toEqual(complete);
  });

  it('retries directory durability when completion publication succeeded but its fsync failed', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const directory = await temp();
    const store = new FilePaymentRecoveryStore(directory);
    await store.claim(record);
    let published = false;
    let syncs = 0;
    vi.mocked(fs.link).mockImplementation(async (from, to) => {
      await actual.link(from, to);
      if (String(to).endsWith('.complete.json')) published = true;
    });
    vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
      const file = await actual.open(path, flags, mode);
      if (flags === 'r' && String(path) === directory) {
        const sync = file.sync.bind(file);
        vi.spyOn(file, 'sync').mockImplementation(async () => {
          if (published && ++syncs === 1) throw Object.assign(new Error('fsync failed'), { code: 'ENOSPC' });
          await sync();
        });
      }
      return file;
    });
    try {
      const complete = { ...record, phase: 'complete' as const, result: { receiptHeader: 'saved' } };
      await expect(store.put(complete)).rejects.toMatchObject({ code: 'ADAPTER_REQUEST_FAILED' });
      expect(await new FilePaymentRecoveryStore(directory).put(complete)).toEqual(complete);
      expect(syncs).toBe(2);
    } finally {
      vi.mocked(fs.link).mockImplementation(actual.link);
      vi.mocked(fs.open).mockImplementation(actual.open);
    }
  });

  it('fails closed if the completion file is corrupt, even when the older checkpoint is valid', async () => {
    const directory = await temp();
    const store = new FilePaymentRecoveryStore(directory);
    await store.claim(record);
    await fs.writeFile(join(directory, `${paymentFingerprint(record.operationId)}.complete.json`), '{}');
    await expect(store.get(record.operationId)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    await expect(store.put({ ...record, phase: 'broadcast' })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  });

  it('rejects capacity overflow without losing prior deduplication or blocking existing checkpoints', async () => {
    const store = new InMemoryPaymentRecoveryStore(1);
    expect(await store.claim(record)).toBe(true);
    await store.put({
      ...record,
      phase: 'complete',
      txHash: 'known',
      sessionCreateBody: 'private request',
      rawSubmissionHash: 'known',
      result: { ok: true },
    });
    await expect(store.claim({ ...record, operationId: 'another' })).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
    expect(await store.claim(record)).toBe(false);
    expect(await store.get(record.operationId)).toEqual({
      ...record,
      phase: 'complete',
      txHash: 'known',
      result: { ok: true },
    });
  });

  it.each(
    ['', '{', '{}', 'null', '"null"', JSON.stringify({ ...record, phase: 'unknown' })].flatMap((content) =>
      ['.json', '.complete.json'].map((suffix) => ({ content, suffix })),
    ),
  )('fails closed on corrupt or incomplete $suffix file $content', async ({ content, suffix }) => {
    const directory = await temp();
    const store = new FilePaymentRecoveryStore(directory);
    // The immutable completion takes precedence even if its older checkpoint is valid.
    if (suffix === '.complete.json') await store.claim(record);
    await fs.writeFile(join(directory, `${paymentFingerprint(record.operationId)}${suffix}`), content);
    await expect(store.get(record.operationId)).rejects.toMatchObject({
      code: 'RECOVERY_REQUIRED',
      message: expect.stringContaining('reconcile'),
      cause: expect.any(Error),
      recovery: undefined,
    });
    if (suffix === '.complete.json')
      await expect(store.claim(record)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    else expect(await store.claim(record)).toBe(false);
  });

  it('syncs directory entries after exclusive creation and atomic replacement', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const parent = await temp();
    const directory = join(parent, 'new', 'state');
    const events: string[] = [];
    vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
      const file = await actual.open(path, flags, mode);
      const sync = file.sync.bind(file);
      vi.spyOn(file, 'sync').mockImplementation(async () => {
        events.push(`sync:${path}`);
        await sync();
      });
      return file;
    });
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      events.push(`rename:${to}`);
      await actual.rename(from, to);
    });
    try {
      const store = new FilePaymentRecoveryStore(directory);
      expect(await store.claim(record)).toBe(true);
      const path = join(directory, `${paymentFingerprint(record.operationId)}.json`);
      expect(events.slice(0, 2)).toEqual([`sync:${join(parent, 'new')}`, `sync:${parent}`]);
      expect(events[2]).toMatch(/\.tmp$/);
      expect(events[3]).toBe(`sync:${directory}`);
      expect(events).toHaveLength(4);
      events.length = 0;
      await store.put({ ...record, phase: 'broadcast', txHash: 'hash' });
      expect(events[0]).toMatch(/\.tmp$/);
      expect(events.slice(1)).toEqual([`rename:${path}`, `sync:${directory}`]);
      expect(await store.get(record.operationId)).toMatchObject({ phase: 'broadcast', txHash: 'hash' });
      // Existing ancestors are provisioned by the operator; do not reopen them.
      events.length = 0;
      const second = new FilePaymentRecoveryStore(directory);
      await second.claim({ ...record, operationId: 'second-worker' });
      expect(events).toHaveLength(2);
      expect(events[0]).toMatch(/\.tmp$/);
      expect(events[1]).toBe(`sync:${directory}`);
    } finally {
      vi.mocked(fs.open).mockImplementation(actual.open);
      vi.mocked(fs.rename).mockImplementation(actual.rename);
    }
  });

  it.each(['writeFile', 'sync'] as const)(
    'leaves the key unused when claim %s fails before publication',
    async (method) => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      const directory = await temp();
      let fail = true;
      vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
        const file = await actual.open(path, flags, mode);
        if (flags === 'wx' && fail) {
          fail = false;
          vi.spyOn(file, method).mockRejectedValueOnce(
            Object.assign(new Error('private filesystem detail'), { code: 'ENOSPC' }),
          );
        }
        return file;
      });
      try {
        const store = new FilePaymentRecoveryStore(directory);
        await expect(store.claim(record)).rejects.toMatchObject({
          code: 'ADAPTER_REQUEST_FAILED',
          message: 'Insufficient storage for the payment journal',
        });
        expect(await store.get(record.operationId)).toBeUndefined();
        expect(await fs.readdir(directory)).toEqual([]);
        expect(await store.claim(record)).toBe(true);
      } finally {
        vi.mocked(fs.open).mockImplementation(actual.open);
      }
    },
  );

  it('publishes only one complete record for concurrent claims', async () => {
    const directory = await temp();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => new FilePaymentRecoveryStore(directory).claim(record)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await new FilePaymentRecoveryStore(directory).get(record.operationId)).toEqual(record);
    expect(await fs.readdir(directory)).toHaveLength(1);
  });

  it.each(['traverse-only parent', 'file durability'] as const)(
    'supports %s without opening inaccessible directories',
    async (scenario) => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      const parent = await temp();
      const directory = join(parent, 'state');
      await fs.mkdir(directory);
      vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
        if (flags === 'r' && (scenario === 'file durability' || String(path) !== directory))
          throw Object.assign(new Error('directory cannot be opened'), { code: 'EACCES' });
        return actual.open(path, flags, mode);
      });
      try {
        const store = new FilePaymentRecoveryStore(directory, {
          durability: scenario === 'file durability' ? 'file' : 'directory',
        });
        expect(await store.claim(record)).toBe(true);
        await store.put({ ...record, phase: 'broadcast', txHash: 'known' });
        expect(await store.get(record.operationId)).toMatchObject({ txHash: 'known' });
      } finally {
        vi.mocked(fs.open).mockImplementation(actual.open);
      }
    },
  );
});
