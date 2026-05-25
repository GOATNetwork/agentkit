import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpGnsApiAdapter } from '../../plugins/gns/adapters/http-gns-api';
import type { CreateX402OrderInput } from '../../plugins/gns/adapters/types';

/**
 * Regression — F2 Round 2 Codex similar-issue scan: `createX402Order`
 * previously coerced `chainId` + `expiresAt` from the backend response via
 * `Number(data.chainId ?? 0)`, which silently turned absent / non-numeric
 * inputs into `0`. The 0 then flowed into payOrder's chain-binding check
 * and surfaced as a misleading `chain_mismatch` error far downstream.
 *
 * Now both fields are strictly required to be positive integers — the
 * malformed response surfaces as ADAPTER_REQUEST_FAILED at the adapter
 * layer where the diagnostic is accurate.
 */
describe('HttpGnsApiAdapter.createX402Order — strict type validation (Issue #3 F2 R2 Codex similar-issue)', () => {
  const validInput: CreateX402OrderInput = {
    name: 'alice.goat',
    owner: '0x39573c7798c3d92Ec4f5e5d6A0C2f5E6B7C8d9e0',
    payer: '0x39573c7798c3d92Ec4f5e5d6A0C2f5E6B7C8d9e0',
    years: 1,
    settlementChainId: 8453,
    settlementTokenSymbol: 'USDC',
    settlementTokenContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    secret: ('0x' + '11'.repeat(32)) as `0x${string}`,
  };

  const baseValidResponse = {
    orderId: 'order-1',
    flow: 'ERC20_TRANSFER',
    payToAddress: '0x000000000000000000000000000000000000bEEF',
    expiresAt: 9999999999,
    chainId: 8453,
    tokenSymbol: 'USDC',
    tokenContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    fromAddress: '0x39573c7798c3d92Ec4f5e5d6A0C2f5E6B7C8d9e0',
    amountWei: '3000000',
    callbackCalldata: '0x01',
    calldataSignRequest: { domain: {}, types: { X: [] }, primaryType: 'X', message: {} },
  };

  function stubFetch(responseBody: unknown): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(responseBody), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('happy path returns a well-formed X402OrderResponse with chainId mirrored to payChainId', async () => {
    stubFetch(baseValidResponse);
    const adapter = new HttpGnsApiAdapter({ network: 'goat-mainnet' });
    const out = await adapter.createX402Order(validInput);
    expect(out.chainId).toBe(8453);
    expect(out.payChainId).toBe(8453);
    expect(out.expiresAt).toBe(9999999999);
  });

  it('fails closed when chainId is a string (no silent Number(...) coercion)', async () => {
    stubFetch({ ...baseValidResponse, chainId: '8453' });
    const adapter = new HttpGnsApiAdapter({ network: 'goat-mainnet' });
    await expect(adapter.createX402Order(validInput)).rejects.toThrow(/malformed chainId.*typeof=string/);
  });

  it('fails closed when chainId is missing', async () => {
    const { chainId: _drop, ...rest } = baseValidResponse;
    void _drop;
    stubFetch(rest);
    const adapter = new HttpGnsApiAdapter({ network: 'goat-mainnet' });
    await expect(adapter.createX402Order(validInput)).rejects.toThrow(/malformed chainId/);
  });

  it('fails closed when chainId is zero (previously the silent default)', async () => {
    stubFetch({ ...baseValidResponse, chainId: 0 });
    const adapter = new HttpGnsApiAdapter({ network: 'goat-mainnet' });
    await expect(adapter.createX402Order(validInput)).rejects.toThrow(/malformed chainId/);
  });

  it('fails closed when expiresAt is missing (refuses orders with no enforceable expiry window)', async () => {
    const { expiresAt: _drop, ...rest } = baseValidResponse;
    void _drop;
    stubFetch(rest);
    const adapter = new HttpGnsApiAdapter({ network: 'goat-mainnet' });
    await expect(adapter.createX402Order(validInput)).rejects.toThrow(/malformed expiresAt/);
  });

  it('fails closed when expiresAt is a string', async () => {
    stubFetch({ ...baseValidResponse, expiresAt: '9999999999' });
    const adapter = new HttpGnsApiAdapter({ network: 'goat-mainnet' });
    await expect(adapter.createX402Order(validInput)).rejects.toThrow(/malformed expiresAt.*typeof=string/);
  });
});
