import { describe, expect, it, vi } from 'vitest';
import { ExecutionRuntime } from '../../core/runtime/execution-runtime';
import { PolicyEngine } from '../../core/policy/policy-engine';
import { ActionProvider } from '../../providers/action-provider';
import { merchantAuthLoginAction } from '../../plugins/x402-merchant/actions/auth.login';
import { merchantDashboardStatsAction } from '../../plugins/x402-merchant/actions/dashboard.stats';
import { merchantProfileUpdateAction } from '../../plugins/x402-merchant/actions/profile.update';
import { merchantOrdersListAction } from '../../plugins/x402-merchant/actions/orders.list';
import type { MerchantPortalClient } from '../../plugins/x402-merchant/adapters/types';
import type { ExecutionHooks } from '../../core/runtime/execution-hooks';

function mockClient(): MerchantPortalClient & {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  setAccessToken: ReturnType<typeof vi.fn>;
  getAccessToken: ReturnType<typeof vi.fn>;
} {
  return {
    get: vi.fn().mockResolvedValue({ ok: true }),
    post: vi.fn().mockResolvedValue({ ok: true }),
    put: vi.fn().mockResolvedValue({ ok: true }),
    delete: vi.fn().mockResolvedValue({ ok: true }),
    setAccessToken: vi.fn(),
    getAccessToken: vi.fn(),
  };
}

describe('merchant portal auth flow through ExecutionRuntime', () => {
  function buildRuntime(hooks?: ExecutionHooks) {
    const client = mockClient();
    const provider = new ActionProvider();
    provider.register(merchantAuthLoginAction(client));
    provider.register(merchantDashboardStatsAction(client));
    provider.register(merchantProfileUpdateAction(client));
    provider.register(merchantOrdersListAction(client));

    const policy = new PolicyEngine({
      allowedNetworks: ['goat-mainnet'],
      maxRiskWithoutConfirm: 'medium',
      writeEnabled: true,
    });

    const runtime = new ExecutionRuntime(policy, {
      maxRetries: 0,
      retryDelayMs: 10,
      validateOutput: false,
      hooks,
    });

    return { runtime, provider, client };
  }

  it('login returns access_token, subsequent actions receive it via ctx.accessToken', async () => {
    const { runtime, provider, client } = buildRuntime();
    client.post.mockResolvedValue({ access_token: 'tok_abc', refresh_token: 'ref_xyz' });

    const baseCtx = { traceId: 't1', network: 'goat-mainnet', now: Date.now() };

    // Step 1: login — no accessToken on context
    const loginResult = await runtime.run(
      provider.get('goat.x402.merchant.auth.login'),
      baseCtx,
      { email: 'a@b.com', password: 'pass' },
      { confirmed: true },
    );

    expect(loginResult.ok).toBe(true);
    expect(loginResult.output?.access_token).toBe('tok_abc');
    // Login must NOT mutate shared client state
    expect(client.setAccessToken).not.toHaveBeenCalled();

    // Step 2: use returned token in subsequent context
    const authedCtx = { ...baseCtx, traceId: 't2', accessToken: loginResult.output!.access_token };

    const statsResult = await runtime.run(
      provider.get('goat.x402.merchant.dashboard.stats'),
      authedCtx,
      {},
    );

    expect(statsResult.ok).toBe(true);
    // Verify the client received the token via RequestOptions
    expect(client.get).toHaveBeenCalledWith(
      '/merchant/v1/dashboard/stats',
      expect.objectContaining({ accessToken: 'tok_abc' }),
    );
  });

  it('accessToken does NOT appear in hook event input (no credential leakage)', async () => {
    const hookEvents: unknown[] = [];
    const hooks: ExecutionHooks = {
      onActionStart: (event) => hookEvents.push(event),
      onActionSuccess: (event) => hookEvents.push(event),
    };

    const { runtime, provider } = buildRuntime(hooks);
    const ctx = { traceId: 't3', network: 'goat-mainnet', now: Date.now(), accessToken: 'secret-tok' };

    await runtime.run(
      provider.get('goat.x402.merchant.dashboard.stats'),
      ctx,
      {},
    );

    expect(hookEvents.length).toBeGreaterThanOrEqual(1);
    for (const event of hookEvents) {
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain('secret-tok');
    }
  });

  it('PUT actions forward ctx.accessToken and pass clean body', async () => {
    const { runtime, provider, client } = buildRuntime();
    const ctx = { traceId: 't4', network: 'goat-mainnet', now: Date.now(), accessToken: 'tok_put' };

    const result = await runtime.run(
      provider.get('goat.x402.merchant.profile.update'),
      ctx,
      { name: 'New Name' },
      { confirmed: true },
    );

    expect(result.ok).toBe(true);
    expect(client.put).toHaveBeenCalledWith(
      '/merchant/v1/profile',
      { name: 'New Name' },
      expect.objectContaining({ accessToken: 'tok_put' }),
    );
    // Body must not contain accessToken
    const body = client.put.mock.calls[0][1];
    expect(body).not.toHaveProperty('accessToken');
    expect(body).not.toHaveProperty('access_token');
  });

  it('auth action output is redacted in onActionSuccess hook (no credential leakage)', async () => {
    const successEvents: { action: string; output: unknown }[] = [];
    const hooks: ExecutionHooks = {
      onActionSuccess: (event) => successEvents.push({ action: event.action, output: event.output }),
    };

    const { runtime, provider, client } = buildRuntime(hooks);
    client.post.mockResolvedValue({ access_token: 'real-tok', refresh_token: 'real-ref', user_id: 'u1' });

    const result = await runtime.run(
      provider.get('goat.x402.merchant.auth.login'),
      { traceId: 't-auth', network: 'goat-mainnet', now: Date.now() },
      { email: 'a@b.com', password: 'pass' },
      { confirmed: true },
    );

    // Caller receives real tokens
    expect(result.ok).toBe(true);
    expect(result.output?.access_token).toBe('real-tok');
    expect(result.output?.refresh_token).toBe('real-ref');

    // Hook receives redacted tokens
    expect(successEvents).toHaveLength(1);
    const hookOutput = successEvents[0].output as Record<string, unknown>;
    expect(hookOutput.access_token).toBe('[REDACTED]');
    expect(hookOutput.refresh_token).toBe('[REDACTED]');
    // Non-sensitive fields still present
    expect(hookOutput.user_id).toBe('u1');
  });

  it('GET actions with query params do not leak accessToken into URL', async () => {
    const { runtime, provider, client } = buildRuntime();
    const ctx = { traceId: 't5', network: 'goat-mainnet', now: Date.now(), accessToken: 'tok_qs' };

    await runtime.run(
      provider.get('goat.x402.merchant.orders.list'),
      ctx,
      { status: 'PAYMENT_CONFIRMED', limit: 5 },
    );

    const path = client.get.mock.calls[0][0] as string;
    expect(path).toContain('status=PAYMENT_CONFIRMED');
    expect(path).toContain('limit=5');
    expect(path).not.toContain('accessToken');
    expect(path).not.toContain('access_token');
    expect(path).not.toContain('tok_qs');
    // Token passed via RequestOptions only
    expect(client.get.mock.calls[0][1]).toEqual(
      expect.objectContaining({ accessToken: 'tok_qs' }),
    );
  });
});
