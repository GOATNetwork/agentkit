import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Redis from 'ioredis';
import { RedisIdempotencyStore } from '../../core/runtime/idempotency/redis-store';

const REDIS_URL = process.env.AGENTKIT_REDIS_URL ?? 'redis://127.0.0.1:6379';
const TEST_PREFIX = `agentkit:test:${Date.now()}:`;

let redis: Redis;
let store: RedisIdempotencyStore;
let canConnect = false;

beforeAll(async () => {
  try {
    redis = new Redis(REDIS_URL, { lazyConnect: true, connectTimeout: 2000 });
    await redis.connect();
    await redis.ping();
    canConnect = true;
    store = new RedisIdempotencyStore(redis);
  } catch {
    canConnect = false;
  }
});

afterAll(async () => {
  if (canConnect) {
    // Clean up test keys
    const keys = await redis.keys(`${TEST_PREFIX}*`);
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  }
});

function key(name: string) {
  return `${TEST_PREFIX}${name}`;
}

describe('RedisIdempotencyStore', () => {
  beforeEach(() => {
    if (!canConnect) return;
  });

  it.skipIf(!canConnect)('acquire returns token, second acquire returns null', async () => {
    const k = key('acquire-basic');
    const token = await store.acquire(k, 60);
    expect(token).toBeTypeOf('string');
    expect(token!.length).toBeGreaterThan(0);

    const second = await store.acquire(k, 60);
    expect(second).toBeNull();
  });

  it.skipIf(!canConnect)('get returns null while in_progress', async () => {
    const k = key('get-in-progress');
    await store.acquire(k, 60);
    expect(await store.get(k)).toBeNull();
  });

  it.skipIf(!canConnect)('complete stores value retrievable by get', async () => {
    const k = key('complete-basic');
    await store.acquire(k, 60);
    await store.complete(k, { data: 42 }, 60);
    const hit = await store.get(k);
    expect(hit).toEqual({ found: true, value: { data: 42 } });
  });

  it.skipIf(!canConnect)('get returns null after TTL expires', async () => {
    const k = key('ttl-expire');
    await store.acquire(k, 1);
    await store.complete(k, 'hello', 1);
    expect(await store.get(k)).toEqual({ found: true, value: 'hello' });

    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 1500));
    expect(await store.get(k)).toBeNull();
  });

  it.skipIf(!canConnect)('stores and retrieves falsy values (0, false, empty string)', async () => {
    const k0 = key('falsy-zero');
    await store.acquire(k0, 60);
    await store.complete(k0, 0, 60);
    expect(await store.get(k0)).toEqual({ found: true, value: 0 });

    const kf = key('falsy-false');
    await store.acquire(kf, 60);
    await store.complete(kf, false, 60);
    expect(await store.get(kf)).toEqual({ found: true, value: false });

    const ke = key('falsy-empty');
    await store.acquire(ke, 60);
    await store.complete(ke, '', 60);
    expect(await store.get(ke)).toEqual({ found: true, value: '' });
  });

  it.skipIf(!canConnect)('stores and retrieves null as a valid completed value', async () => {
    const k = key('null-value');
    await store.acquire(k, 60);
    await store.complete(k, null, 60);
    const hit = await store.get(k);
    expect(hit).toEqual({ found: true, value: null });
  });

  // --- Lua compare-and-delete behavior ---

  it.skipIf(!canConnect)('release with correct token removes lock atomically', async () => {
    const k = key('release-correct');
    const token = await store.acquire(k, 60);
    expect(token).toBeTypeOf('string');

    // Lock is held — second acquire fails
    expect(await store.acquire(k, 60)).toBeNull();

    // Release with correct token
    await store.release(k, token!);

    // Now re-acquire should succeed
    const newToken = await store.acquire(k, 60);
    expect(newToken).toBeTypeOf('string');
    expect(newToken).not.toBe(token);
  });

  it.skipIf(!canConnect)('release with wrong token does NOT remove lock (Lua atomic check)', async () => {
    const k = key('release-wrong-token');
    const token = await store.acquire(k, 60);
    expect(token).toBeTypeOf('string');

    // Try to release with a wrong token
    await store.release(k, 'wrong-token-value');

    // Lock should still be held
    expect(await store.acquire(k, 60)).toBeNull();
  });

  it.skipIf(!canConnect)('release does not remove completed entries', async () => {
    const k = key('release-completed');
    const token = await store.acquire(k, 60);
    await store.complete(k, 'done', 60);

    // Release should be a no-op since status is completed
    await store.release(k, token!);

    // Value should still be retrievable
    expect(await store.get(k)).toEqual({ found: true, value: 'done' });
  });

  it.skipIf(!canConnect)('release is no-op for nonexistent key', async () => {
    // Should not throw
    await store.release(key('nonexistent'), 'any-token');
  });

  it.skipIf(!canConnect)('concurrent acquire — only one wins', async () => {
    const k = key('concurrent-acquire');
    const results = await Promise.all([
      store.acquire(k, 60),
      store.acquire(k, 60),
      store.acquire(k, 60),
    ]);

    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
  });

  it.skipIf(!canConnect)('full lifecycle: acquire → fail → release → re-acquire → complete → cache hit', async () => {
    const k = key('full-lifecycle');

    // Step 1: acquire
    const token1 = await store.acquire(k, 60);
    expect(token1).toBeTypeOf('string');

    // Step 2: simulate failure, release lock
    await store.release(k, token1!);

    // Step 3: re-acquire after release
    const token2 = await store.acquire(k, 60);
    expect(token2).toBeTypeOf('string');

    // Step 4: complete successfully
    await store.complete(k, { result: 'success' }, 60);

    // Step 5: cache hit
    const hit = await store.get(k);
    expect(hit).toEqual({ found: true, value: { result: 'success' } });

    // Step 6: further acquire should fail (completed entry exists)
    expect(await store.acquire(k, 60)).toBeNull();
  });
});
