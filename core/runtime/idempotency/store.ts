export interface IdempotencyStore {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T, ttlSeconds?: number): Promise<void>;
}

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const DEFAULT_TTL_SECONDS = 3600;

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly cache = new Map<string, CacheEntry>();

  async get<T = unknown>(key: string): Promise<T | null> {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.value as T;
  }

  async set<T = unknown>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const expiresAt = Date.now() + (ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000;
    this.cache.set(key, { value, expiresAt });
  }
}
