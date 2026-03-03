import Redis from 'ioredis';
import type { IdempotencyStore } from './store';

export class RedisIdempotencyStore implements IdempotencyStore {
  constructor(private readonly redis: Redis) {}

  async get<T = unknown>(key: string): Promise<T | null> {
    const v = await this.redis.get(key);
    if (!v) return null;
    return JSON.parse(v) as T;
  }

  async set<T = unknown>(key: string, value: T, ttlSeconds = 3600): Promise<void> {
    await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  }
}
