import { describe, expect, it } from 'vitest';
import { createIdempotencyStoreFromEnv } from '../../core/runtime/idempotency/factory';

describe('idempotency factory', () => {
  it('defaults to memory mode', () => {
    delete process.env.AGENTKIT_IDEMPOTENCY_MODE;
    const { mode } = createIdempotencyStoreFromEnv();
    expect(mode).toBe('memory');
  });
});
