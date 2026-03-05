import { describe, it, expect, afterAll } from 'vitest';
import Redis from 'ioredis';
import { RedisIdempotencyStore } from '../../core/runtime/idempotency/redis-store';

const REDIS_URL = process.env.AGENTKIT_REDIS_URL ?? 'redis://127.0.0.1:6379';
const REQUIRE_REDIS = process.env.REQUIRE_REDIS === '1';
const TEST_PREFIX = `agentkit:test:${Date.now()}:`;

// Probe Redis connectivity at module level (top-level await in ESM)
let redis: Redis | undefined;
let store: RedisIdempotencyStore | undefined;
let canConnect = false;
let connectError: unknown;

try {
  const r = new Redis(REDIS_URL, { lazyConnect: true, connectTimeout: 2000 });
  // Avoid noisy "Unhandled error event" logs; explicit connect() handles failure.
  r.on('error', () => {});
  await r.connect();
  await r.ping();
  redis = r;
  store = new RedisIdempotencyStore(r);
  canConnect = true;
} catch (err) {
  connectError = err;
  canConnect = false;
}

if (REQUIRE_REDIS && !canConnect) {
  throw new Error(
    `Redis is required for this test run but is not reachable at ${REDIS_URL}. ` +
      `Start Redis locally and retry.`,
    { cause: connectError as Error | undefined }
  );
}

afterAll(async () => {
  if (redis) {
    const keys = await redis.keys(`${TEST_PREFIX}*`);
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  }
});

function key(name: string) {
  return `${TEST_PREFIX}${name}`;
}

// Now canConnect is resolved — skipIf evaluates correctly
describe.skipIf(!canConnect)('RedisIdempotencyStore', () => {
  // store is guaranteed non-null inside this block
  function s() {
    return store!;
  }

  it('acquire returns token, second acquire returns null', async () => {
    const k = key('acquire-basic');
    const token = await s().acquire(k, 60);
    expect(token).toBeTypeOf('string');
    expect(token!.length).toBeGreaterThan(0);

    const second = await s().acquire(k, 60);
    expect(second).toBeNull();
  });

  it('get returns null while in_progress', async () => {
    const k = key('get-in-progress');
    await s().acquire(k, 60);
    expect(await s().get(k)).toBeNull();
  });

  it('complete stores value retrievable by get', async () => {
    const k = key('complete-basic');
    await s().acquire(k, 60);
    await s().complete(k, { data: 42 }, 60);
    const hit = await s().get(k);
    expect(hit).toEqual({ found: true, value: { data: 42 } });
  });

  it('get returns null after TTL expires', async () => {
    const k = key('ttl-expire');
    await s().acquire(k, 1);
    await s().complete(k, 'hello', 1);
    expect(await s().get(k)).toEqual({ found: true, value: 'hello' });

    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 1500));
    expect(await s().get(k)).toBeNull();
  });

  it('stores and retrieves falsy values (0, false, empty string)', async () => {
    const k0 = key('falsy-zero');
    await s().acquire(k0, 60);
    await s().complete(k0, 0, 60);
    expect(await s().get(k0)).toEqual({ found: true, value: 0 });

    const kf = key('falsy-false');
    await s().acquire(kf, 60);
    await s().complete(kf, false, 60);
    expect(await s().get(kf)).toEqual({ found: true, value: false });

    const ke = key('falsy-empty');
    await s().acquire(ke, 60);
    await s().complete(ke, '', 60);
    expect(await s().get(ke)).toEqual({ found: true, value: '' });
  });

  it('stores and retrieves null as a valid completed value', async () => {
    const k = key('null-value');
    await s().acquire(k, 60);
    await s().complete(k, null, 60);
    const hit = await s().get(k);
    expect(hit).toEqual({ found: true, value: null });
  });

  // --- Lua compare-and-delete behavior ---

  it('release with correct token removes lock atomically', async () => {
    const k = key('release-correct');
    const token = await s().acquire(k, 60);
    expect(token).toBeTypeOf('string');

    // Lock is held — second acquire fails
    expect(await s().acquire(k, 60)).toBeNull();

    // Release with correct token
    await s().release(k, token!);

    // Now re-acquire should succeed
    const newToken = await s().acquire(k, 60);
    expect(newToken).toBeTypeOf('string');
    expect(newToken).not.toBe(token);
  });

  it('release with wrong token does NOT remove lock (Lua atomic check)', async () => {
    const k = key('release-wrong-token');
    const token = await s().acquire(k, 60);
    expect(token).toBeTypeOf('string');

    // Try to release with a wrong token
    await s().release(k, 'wrong-token-value');

    // Lock should still be held
    expect(await s().acquire(k, 60)).toBeNull();
  });

  it('release does not remove completed entries', async () => {
    const k = key('release-completed');
    const token = await s().acquire(k, 60);
    await s().complete(k, 'done', 60);

    // Release should be a no-op since status is completed
    await s().release(k, token!);

    // Value should still be retrievable
    expect(await s().get(k)).toEqual({ found: true, value: 'done' });
  });

  it('release is no-op for nonexistent key', async () => {
    // Should not throw
    await s().release(key('nonexistent'), 'any-token');
  });

  it('concurrent acquire — only one wins', async () => {
    const k = key('concurrent-acquire');
    const results = await Promise.all([
      s().acquire(k, 60),
      s().acquire(k, 60),
      s().acquire(k, 60),
    ]);

    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
  });

  it('full lifecycle: acquire → fail → release → re-acquire → complete → cache hit', async () => {
    const k = key('full-lifecycle');

    // Step 1: acquire
    const token1 = await s().acquire(k, 60);
    expect(token1).toBeTypeOf('string');

    // Step 2: simulate failure, release lock
    await s().release(k, token1!);

    // Step 3: re-acquire after release
    const token2 = await s().acquire(k, 60);
    expect(token2).toBeTypeOf('string');

    // Step 4: complete successfully
    await s().complete(k, { result: 'success' }, 60);

    // Step 5: cache hit
    const hit = await s().get(k);
    expect(hit).toEqual({ found: true, value: { result: 'success' } });

    // Step 6: further acquire should fail (completed entry exists)
    expect(await s().acquire(k, 60)).toBeNull();
  });
});
