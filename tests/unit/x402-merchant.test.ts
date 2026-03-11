import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  merchantAuthRegisterAction,
  merchantAuthRegisterInviteAction,
  merchantAuthLoginAction,
  merchantAuthRefreshAction,
  merchantDashboardStatsAction,
  merchantProfileGetAction,
  merchantProfileUpdateAction,
  merchantOrdersListAction,
  merchantOrdersGetAction,
  merchantBalanceGetAction,
  merchantBalanceTransactionsAction,
  merchantBalanceFeesConfigAction,
  merchantSupportedTokensListAction,
  merchantAddressesListAction,
  merchantAddressesAddAction,
  merchantAddressesRemoveAction,
  merchantCallbackContractsListAction,
  merchantCallbackContractsSubmitAction,
  merchantCallbackContractsRemoveAction,
  merchantCallbackContractsCancelSubmissionAction,
  merchantApiKeysGetAction,
  merchantApiKeysRotateAction,
  merchantWebhooksListAction,
  merchantWebhooksCreateAction,
  merchantWebhooksUpdateAction,
  merchantWebhooksDeleteAction,
  merchantInviteCodesListAction,
  merchantInviteCodesCreateAction,
  merchantInviteCodesRevokeAction,
  merchantAuditLogsListAction,
} from '../../plugins/x402-merchant/index';
import type { MerchantPortalClient } from '../../plugins/x402-merchant/adapters/types';

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

const ctx = { traceId: 't1', network: 'goat-mainnet', now: Date.now() };

// ── Auth ──────────────────────────────────────────────────────────

describe('merchant.auth.register', () => {
  it('POSTs to /merchant/v1/auth/register', async () => {
    const client = mockClient();
    const action = merchantAuthRegisterAction(client);
    expect(action.name).toBe('goat.x402.merchant.auth.register');
    expect(action.riskLevel).toBe('high');

    const input = { merchant_id: 'shop', name: 'Shop', email: 'a@b.com', password: 'pass123', receive_type: 'DIRECT' as const };
    await action.execute(ctx, input);
    expect(client.post).toHaveBeenCalledWith('/merchant/v1/auth/register', input, undefined);
  });
});

describe('merchant.auth.register-invite', () => {
  it('POSTs to /merchant/v1/auth/register/invite and sets token', async () => {
    const client = mockClient();
    client.post.mockResolvedValue({ access_token: 'tok123', refresh_token: 'ref456' });
    const action = merchantAuthRegisterInviteAction(client);
    expect(action.name).toBe('goat.x402.merchant.auth.register-invite');

    await action.execute(ctx, { invite_code: 'inv_abc', email: 'a@b.com', password: 'pass' });
    expect(client.setAccessToken).toHaveBeenCalledWith('tok123');
  });
});

describe('merchant.auth.login', () => {
  it('POSTs to /merchant/v1/auth/login and sets token', async () => {
    const client = mockClient();
    client.post.mockResolvedValue({ access_token: 'tok', refresh_token: 'ref' });
    const action = merchantAuthLoginAction(client);
    expect(action.name).toBe('goat.x402.merchant.auth.login');

    await action.execute(ctx, { email: 'a@b.com', password: 'pass' });
    expect(client.post).toHaveBeenCalledWith('/merchant/v1/auth/login', expect.any(Object), undefined);
    expect(client.setAccessToken).toHaveBeenCalledWith('tok');
  });
});

describe('merchant.auth.refresh', () => {
  it('POSTs to /merchant/v1/auth/refresh and sets new token', async () => {
    const client = mockClient();
    client.post.mockResolvedValue({ access_token: 'newtok' });
    const action = merchantAuthRefreshAction(client);
    expect(action.name).toBe('goat.x402.merchant.auth.refresh');
    expect(action.riskLevel).toBe('low');

    await action.execute(ctx, { refresh_token: 'ref' });
    expect(client.setAccessToken).toHaveBeenCalledWith('newtok');
  });
});

// ── Dashboard ─────────────────────────────────────────────────────

describe('merchant.dashboard.stats', () => {
  it('GETs /merchant/v1/dashboard/stats', async () => {
    const client = mockClient();
    const action = merchantDashboardStatsAction(client);
    expect(action.name).toBe('goat.x402.merchant.dashboard.stats');
    expect(action.riskLevel).toBe('read');

    await action.execute(ctx, {});
    expect(client.get).toHaveBeenCalledWith('/merchant/v1/dashboard/stats', undefined);
  });
});

// ── Profile ───────────────────────────────────────────────────────

describe('merchant.profile', () => {
  it('get GETs /merchant/v1/profile', async () => {
    const client = mockClient();
    const action = merchantProfileGetAction(client);
    expect(action.name).toBe('goat.x402.merchant.profile.get');
    await action.execute(ctx, {});
    expect(client.get).toHaveBeenCalledWith('/merchant/v1/profile', undefined);
  });

  it('update PUTs /merchant/v1/profile', async () => {
    const client = mockClient();
    const action = merchantProfileUpdateAction(client);
    expect(action.name).toBe('goat.x402.merchant.profile.update');
    expect(action.riskLevel).toBe('medium');

    await action.execute(ctx, { name: 'New Name' });
    expect(client.put).toHaveBeenCalledWith('/merchant/v1/profile', { name: 'New Name' }, undefined);
  });
});

// ── Orders ────────────────────────────────────────────────────────

describe('merchant.orders', () => {
  it('list with filters builds query string', async () => {
    const client = mockClient();
    const action = merchantOrdersListAction(client);
    expect(action.name).toBe('goat.x402.merchant.orders.list');

    await action.execute(ctx, { status: 'PAYMENT_CONFIRMED', limit: 10 });
    const path = client.get.mock.calls[0][0] as string;
    expect(path).toContain('/merchant/v1/orders?');
    expect(path).toContain('status=PAYMENT_CONFIRMED');
    expect(path).toContain('limit=10');
  });

  it('get fetches by order ID', async () => {
    const client = mockClient();
    const action = merchantOrdersGetAction(client);
    expect(action.name).toBe('goat.x402.merchant.orders.get');

    await action.execute(ctx, { order_id: 'uuid-123' });
    expect(client.get).toHaveBeenCalledWith('/merchant/v1/orders/uuid-123', undefined);
  });
});

// ── Balance & Fees ────────────────────────────────────────────────

describe('merchant.balance', () => {
  it('get GETs /merchant/v1/balance', async () => {
    const client = mockClient();
    const action = merchantBalanceGetAction(client);
    await action.execute(ctx, {});
    expect(client.get).toHaveBeenCalledWith('/merchant/v1/balance', undefined);
  });

  it('transactions GETs with pagination', async () => {
    const client = mockClient();
    const action = merchantBalanceTransactionsAction(client);
    await action.execute(ctx, { limit: 20, offset: 0 });
    const path = client.get.mock.calls[0][0] as string;
    expect(path).toContain('limit=20');
    expect(path).toContain('offset=0');
  });

  it('fees-config GETs /merchant/v1/fees/config', async () => {
    const client = mockClient();
    const action = merchantBalanceFeesConfigAction(client);
    await action.execute(ctx, {});
    expect(client.get).toHaveBeenCalledWith('/merchant/v1/fees/config', undefined);
  });
});

// ── Supported Tokens ──────────────────────────────────────────────

describe('merchant.supported-tokens.list', () => {
  it('GETs /merchant/v1/supported-tokens', async () => {
    const client = mockClient();
    const action = merchantSupportedTokensListAction(client);
    await action.execute(ctx, {});
    expect(client.get).toHaveBeenCalledWith('/merchant/v1/supported-tokens', undefined);
  });
});

// ── Addresses ─────────────────────────────────────────────────────

describe('merchant.addresses', () => {
  it('list GETs /merchant/v1/addresses', async () => {
    const client = mockClient();
    const action = merchantAddressesListAction(client);
    await action.execute(ctx, {});
    expect(client.get).toHaveBeenCalledWith('/merchant/v1/addresses', undefined);
  });

  it('add POSTs to /merchant/v1/addresses', async () => {
    const client = mockClient();
    const action = merchantAddressesAddAction(client);
    expect(action.riskLevel).toBe('high');

    const input = {
      chain_id: 1,
      token_contract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      symbol: 'USDC',
      address: '0x1111111111111111111111111111111111111111',
    };
    await action.execute(ctx, input);
    expect(client.post).toHaveBeenCalledWith('/merchant/v1/addresses', input, undefined);
  });

  it('remove DELETEs /merchant/v1/addresses/:chain_id/:symbol', async () => {
    const client = mockClient();
    const action = merchantAddressesRemoveAction(client);
    await action.execute(ctx, { chain_id: 1, symbol: 'USDC' });
    expect(client.delete).toHaveBeenCalledWith('/merchant/v1/addresses/1/USDC', undefined);
  });
});

// ── Callback Contracts ────────────────────────────────────────────

describe('merchant.callback-contracts', () => {
  it('list GETs /merchant/v1/callback-contracts', async () => {
    const client = mockClient();
    const action = merchantCallbackContractsListAction(client);
    await action.execute(ctx, {});
    expect(client.get).toHaveBeenCalledWith('/merchant/v1/callback-contracts', undefined);
  });

  it('submit POSTs callback contract for review', async () => {
    const client = mockClient();
    const action = merchantCallbackContractsSubmitAction(client);
    expect(action.riskLevel).toBe('high');

    const input = {
      chain_id: 1,
      spent_address: '0x1111111111111111111111111111111111111111',
      spent_permit2_func_abi: 'function x402SpentPermit2(...)',
      spent_erc3009_func_abi: 'function x402SpentEip3009(...)',
      eip712_name: 'Adapter',
      eip712_version: '1',
    };
    await action.execute(ctx, input);
    expect(client.post).toHaveBeenCalledWith('/merchant/v1/callback-contracts', input, undefined);
  });

  it('remove DELETEs /merchant/v1/callback-contracts/:chain_id', async () => {
    const client = mockClient();
    const action = merchantCallbackContractsRemoveAction(client);
    await action.execute(ctx, { chain_id: 1 });
    expect(client.delete).toHaveBeenCalledWith('/merchant/v1/callback-contracts/1', undefined);
  });

  it('cancel-submission DELETEs /merchant/v1/callback-contracts/submissions/:id', async () => {
    const client = mockClient();
    const action = merchantCallbackContractsCancelSubmissionAction(client);
    await action.execute(ctx, { submission_id: 'sub-uuid' });
    expect(client.delete).toHaveBeenCalledWith('/merchant/v1/callback-contracts/submissions/sub-uuid', undefined);
  });
});

// ── API Keys ──────────────────────────────────────────────────────

describe('merchant.api-keys', () => {
  it('get GETs /merchant/v1/api-keys', async () => {
    const client = mockClient();
    const action = merchantApiKeysGetAction(client);
    await action.execute(ctx, {});
    expect(client.get).toHaveBeenCalledWith('/merchant/v1/api-keys', undefined);
  });

  it('rotate POSTs /merchant/v1/api-keys/rotate', async () => {
    const client = mockClient();
    const action = merchantApiKeysRotateAction(client);
    expect(action.riskLevel).toBe('high');
    await action.execute(ctx, {});
    expect(client.post).toHaveBeenCalledWith('/merchant/v1/api-keys/rotate', undefined, undefined);
  });
});

// ── Webhooks ──────────────────────────────────────────────────────

describe('merchant.webhooks', () => {
  it('list GETs /merchant/v1/webhooks', async () => {
    const client = mockClient();
    const action = merchantWebhooksListAction(client);
    await action.execute(ctx, {});
    expect(client.get).toHaveBeenCalledWith('/merchant/v1/webhooks', undefined);
  });

  it('create POSTs to /merchant/v1/webhooks', async () => {
    const client = mockClient();
    const action = merchantWebhooksCreateAction(client);
    const input = { url: 'https://example.com/hook', events: ['order.invoiced'] };
    await action.execute(ctx, input);
    expect(client.post).toHaveBeenCalledWith('/merchant/v1/webhooks', input, undefined);
  });

  it('update PUTs /merchant/v1/webhooks/:id', async () => {
    const client = mockClient();
    const action = merchantWebhooksUpdateAction(client);
    await action.execute(ctx, { webhook_id: 'wh-uuid', enabled: false });
    expect(client.put).toHaveBeenCalledWith('/merchant/v1/webhooks/wh-uuid', { enabled: false }, undefined);
  });

  it('delete DELETEs /merchant/v1/webhooks/:id', async () => {
    const client = mockClient();
    const action = merchantWebhooksDeleteAction(client);
    await action.execute(ctx, { webhook_id: 'wh-uuid' });
    expect(client.delete).toHaveBeenCalledWith('/merchant/v1/webhooks/wh-uuid', undefined);
  });
});

// ── Invite Codes ──────────────────────────────────────────────────

describe('merchant.invite-codes', () => {
  it('list GETs /merchant/v1/invite-codes', async () => {
    const client = mockClient();
    const action = merchantInviteCodesListAction(client);
    await action.execute(ctx, {});
    expect(client.get).toHaveBeenCalledWith('/merchant/v1/invite-codes', undefined);
  });

  it('create POSTs to /merchant/v1/invite-codes', async () => {
    const client = mockClient();
    const action = merchantInviteCodesCreateAction(client);
    await action.execute(ctx, { expires_in_hours: 48 });
    expect(client.post).toHaveBeenCalledWith('/merchant/v1/invite-codes', { expires_in_hours: 48 }, undefined);
  });

  it('revoke DELETEs /merchant/v1/invite-codes/:id', async () => {
    const client = mockClient();
    const action = merchantInviteCodesRevokeAction(client);
    await action.execute(ctx, { code_id: 'code-uuid' });
    expect(client.delete).toHaveBeenCalledWith('/merchant/v1/invite-codes/code-uuid', undefined);
  });
});

// ── Audit Logs ────────────────────────────────────────────────────

describe('merchant.audit-logs.list', () => {
  it('GETs /merchant/v1/audit-logs with pagination', async () => {
    const client = mockClient();
    const action = merchantAuditLogsListAction(client);
    await action.execute(ctx, { limit: 30, offset: 0 });
    const path = client.get.mock.calls[0][0] as string;
    expect(path).toContain('/merchant/v1/audit-logs?');
    expect(path).toContain('limit=30');
  });
});

// ── HttpMerchantPortalClient ──────────────────────────────────────

describe('HttpMerchantPortalClient', () => {
  it('can be imported and constructed', async () => {
    const { HttpMerchantPortalClient } = await import('../../plugins/x402-merchant/adapters/http-client');
    const client = new HttpMerchantPortalClient('http://localhost:8080');
    expect(client.getAccessToken()).toBeUndefined();
    client.setAccessToken('test-token');
    expect(client.getAccessToken()).toBe('test-token');
  });

  it('constructs with initial accessToken', async () => {
    const { HttpMerchantPortalClient } = await import('../../plugins/x402-merchant/adapters/http-client');
    const client = new HttpMerchantPortalClient('http://localhost:8080', { accessToken: 'initial' });
    expect(client.getAccessToken()).toBe('initial');
  });
});

// ── Action count ──────────────────────────────────────────────────

describe('x402-merchant plugin exports', () => {
  it('exports 30 action factory functions', async () => {
    const exports = await import('../../plugins/x402-merchant/index');
    const actionFactories = Object.entries(exports).filter(
      ([name, value]) => name.startsWith('merchant') && typeof value === 'function',
    );
    expect(actionFactories).toHaveLength(30);
  });
});
