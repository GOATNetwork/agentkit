import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryIdempotencyStore } from '../../core/runtime/idempotency/store';

describe('InMemoryIdempotencyStore', () => {
  let store: InMemoryIdempotencyStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new InMemoryIdempotencyStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null for nonexistent key', async () => {
    expect(await store.get('missing')).toBeNull();
  });

  it('acquire returns token on first call, null on second', async () => {
    const token = await store.acquire('key1', 60);
    expect(token).toBeTypeOf('string');
    expect(await store.acquire('key1', 60)).toBeNull();
  });

  it('get returns null while in_progress', async () => {
    await store.acquire('key1', 60);
    expect(await store.get('key1')).toBeNull();
  });

  it('complete stores value retrievable by get', async () => {
    await store.acquire('key1', 60);
    await store.complete('key1', { data: 42 }, 60);
    const hit = await store.get('key1');
    expect(hit).toEqual({ found: true, value: { data: 42 } });
  });

  it('returns null after TTL expires', async () => {
    await store.acquire('key2', 10);
    await store.complete('key2', 'hello', 10);
    expect(await store.get('key2')).toEqual({ found: true, value: 'hello' });

    vi.advanceTimersByTime(11_000);

    expect(await store.get('key2')).toBeNull();
  });

  it('allows re-acquire after TTL expires', async () => {
    await store.acquire('key3', 10);
    vi.advanceTimersByTime(11_000);
    const token = await store.acquire('key3', 10);
    expect(token).toBeTypeOf('string');
  });

  it('uses default TTL of 3600s when ttlSeconds is not provided', async () => {
    await store.acquire('key4');
    await store.complete('key4', 'value');

    vi.advanceTimersByTime(3599_000);
    expect(await store.get('key4')).toEqual({ found: true, value: 'value' });

    vi.advanceTimersByTime(2_000);
    expect(await store.get('key4')).toBeNull();
  });

  it('complete overwrites existing value', async () => {
    await store.acquire('key5', 60);
    await store.complete('key5', 'first', 60);
    await store.complete('key5', 'second', 60);
    expect(await store.get('key5')).toEqual({ found: true, value: 'second' });
  });

  it('release with correct token removes in_progress lock, allowing re-acquire', async () => {
    const token = await store.acquire('key6', 60);
    expect(await store.acquire('key6', 60)).toBeNull(); // locked
    await store.release('key6', token!);
    const newToken = await store.acquire('key6', 60);
    expect(newToken).toBeTypeOf('string'); // released, can re-acquire
  });

  it('release with wrong token does not remove lock', async () => {
    await store.acquire('key6b', 60);
    await store.release('key6b', 'wrong-token');
    expect(await store.acquire('key6b', 60)).toBeNull(); // still locked
  });

  it('release does not remove completed entries', async () => {
    const token = await store.acquire('key7', 60);
    await store.complete('key7', 'done', 60);
    await store.release('key7', token!); // should be a no-op (status is completed)
    expect(await store.get('key7')).toEqual({ found: true, value: 'done' });
  });

  it('release is no-op for nonexistent key', async () => {
    await store.release('nonexistent', 'any-token'); // should not throw
  });

  it('stores and retrieves falsy values (0, false, empty string)', async () => {
    await store.acquire('zero', 60);
    await store.complete('zero', 0, 60);
    expect(await store.get('zero')).toEqual({ found: true, value: 0 });

    await store.acquire('false', 60);
    await store.complete('false', false, 60);
    expect(await store.get('false')).toEqual({ found: true, value: false });

    await store.acquire('empty', 60);
    await store.complete('empty', '', 60);
    expect(await store.get('empty')).toEqual({ found: true, value: '' });
  });

  it('stores and retrieves null as a valid completed value', async () => {
    await store.acquire('null_val', 60);
    await store.complete('null_val', null, 60);
    const hit = await store.get('null_val');
    expect(hit).toEqual({ found: true, value: null });
  });
});
