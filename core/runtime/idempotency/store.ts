import { randomUUID } from 'node:crypto';

export interface IdempotencyEntry<T = unknown> {
  status: 'in_progress' | 'completed';
  token?: string;
  value?: T;
  expiresAt: number;
}

export interface CacheHit<T = unknown> {
  found: true;
  value: T;
}

export interface IdempotencyStore {
  /** Try to acquire an exclusive lock for key. Returns a token string if acquired, null if already held. */
  acquire(key: string, ttlSeconds?: number): Promise<string | null>;
  /** Mark key as completed with the given value. */
  complete<T = unknown>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  /** Release the lock for key only if the token matches (on execution failure). */
  release(key: string, token: string): Promise<void>;
  /** Get the completed value for key, or null if not found/expired/in-progress. */
  get<T = unknown>(key: string): Promise<CacheHit<T> | null>;
}

const DEFAULT_TTL_SECONDS = 3600;

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly cache = new Map<string, IdempotencyEntry>();

  async acquire(key: string, ttlSeconds?: number): Promise<string | null> {
    const existing = this.cache.get(key);
    if (existing && Date.now() <= existing.expiresAt) {
      return null; // already acquired or completed
    }
    const token = randomUUID();
    const expiresAt = Date.now() + (ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000;
    this.cache.set(key, { status: 'in_progress', token, expiresAt });
    return token;
  }

  async complete<T = unknown>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const expiresAt = Date.now() + (ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000;
    this.cache.set(key, { status: 'completed', value, expiresAt });
  }

  async release(key: string, token: string): Promise<void> {
    const existing = this.cache.get(key);
    if (existing && existing.status === 'in_progress' && existing.token === token) {
      this.cache.delete(key);
    }
  }

  async get<T = unknown>(key: string): Promise<CacheHit<T> | null> {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    if (entry.status !== 'completed') return null;
    return { found: true, value: entry.value as T };
  }
}
