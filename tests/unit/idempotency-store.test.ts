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

  it('stores and retrieves a value', async () => {
    await store.set('key1', { data: 42 }, 60);
    expect(await store.get('key1')).toEqual({ data: 42 });
  });

  it('returns null after TTL expires', async () => {
    await store.set('key2', 'hello', 10);
    expect(await store.get('key2')).toBe('hello');

    vi.advanceTimersByTime(11_000);

    expect(await store.get('key2')).toBeNull();
  });

  it('uses default TTL of 3600s when ttlSeconds is not provided', async () => {
    await store.set('key3', 'value');

    vi.advanceTimersByTime(3599_000);
    expect(await store.get('key3')).toBe('value');

    vi.advanceTimersByTime(2_000);
    expect(await store.get('key3')).toBeNull();
  });

  it('overwrites existing key', async () => {
    await store.set('key4', 'first', 60);
    await store.set('key4', 'second', 60);
    expect(await store.get('key4')).toBe('second');
  });
});
