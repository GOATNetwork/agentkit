import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import type { CacheHit, IdempotencyStore } from './store';

// Lua script: delete key only if stored token matches (atomic compare-and-delete)
const RELEASE_LUA = `
local val = redis.call('GET', KEYS[1])
if not val then return 0 end
local entry = cjson.decode(val)
if entry.status == 'in_progress' and entry.token == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export class RedisIdempotencyStore implements IdempotencyStore {
  constructor(private readonly redis: Redis) {}

  async acquire(key: string, ttlSeconds = 3600): Promise<string | null> {
    const token = randomUUID();
    // SET NX — only set if key does not exist (atomic)
    const result = await this.redis.set(
      key,
      JSON.stringify({ status: 'in_progress', token }),
      'EX',
      ttlSeconds,
      'NX'
    );
    return result === 'OK' ? token : null;
  }

  async complete<T = unknown>(key: string, value: T, ttlSeconds = 3600): Promise<void> {
    await this.redis.set(key, JSON.stringify({ status: 'completed', value }), 'EX', ttlSeconds);
  }

  async release(key: string, token: string): Promise<void> {
    await this.redis.eval(RELEASE_LUA, 1, key, token);
  }

  async get<T = unknown>(key: string): Promise<CacheHit<T> | null> {
    const v = await this.redis.get(key);
    if (!v) return null;
    const entry = JSON.parse(v) as { status: string; value?: T };
    if (entry.status !== 'completed') return null;
    return { found: true, value: entry.value as T };
  }
}
