import { execSync } from 'node:child_process';

process.env.REQUIRE_REDIS = '1';
process.env.AGENTKIT_REDIS_URL ??= 'redis://127.0.0.1:6379';

execSync('pnpm vitest run tests/integration/redis-idempotency-store.test.ts', {
  stdio: 'inherit',
  env: process.env,
});
