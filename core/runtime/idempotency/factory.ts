import Redis from 'ioredis';
import { RedisIdempotencyStore } from './redis-store';
import { InMemoryIdempotencyStore, type IdempotencyStore } from './store';

export interface IdempotencyFactoryResult {
  store: IdempotencyStore;
  mode: 'memory' | 'redis';
}

export function createIdempotencyStoreFromEnv(): IdempotencyFactoryResult {
  const mode = (process.env.AGENTKIT_IDEMPOTENCY_MODE ?? 'memory').toLowerCase();

  if (mode === 'redis') {
    const redisUrl = process.env.AGENTKIT_REDIS_URL ?? 'redis://127.0.0.1:6379';
    const redis = new Redis(redisUrl);
    return {
      store: new RedisIdempotencyStore(redis),
      mode: 'redis',
    };
  }

  return {
    store: new InMemoryIdempotencyStore(),
    mode: 'memory',
  };
}
