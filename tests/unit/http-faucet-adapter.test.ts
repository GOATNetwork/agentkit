import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpFaucetAdapter } from '../../plugins/faucet/adapters/http-faucet';
import { ErrorCodes } from '../../core/errors/error-codes';

describe('HttpFaucetAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('calls the faucet chain list endpoint', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ chains: ['goat-testnet3', 'sepolia'] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new HttpFaucetAdapter('https://faucet.example.com/api');
    const result = await adapter.getChains();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://faucet.example.com/api/faucet/chains');
    expect(result).toEqual({ chains: ['goat-testnet3', 'sepolia'] });
  });

  it('maps tokenAddress to token_address and normalizes tx_hash', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ tx_hash: '0xtx123', message: 'queued' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new HttpFaucetAdapter('https://faucet.example.com/api');
    const result = await adapter.requestFunds({
      chain: 'bsc-testnet',
      address: '0x1234567890abcdef1234567890abcdef12345678',
      tokenAddress: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://faucet.example.com/api/faucet');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      chain: 'bsc-testnet',
      address: '0x1234567890abcdef1234567890abcdef12345678',
      token_address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    });
    expect(result).toEqual({
      success: true,
      txHash: '0xtx123',
      message: 'queued',
      raw: { tx_hash: '0xtx123', message: 'queued' },
    });
  });

  it('raises ADAPTER_REQUEST_FAILED on upstream errors', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ message: 'rate limited' }), { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new HttpFaucetAdapter('https://faucet.example.com/api');

    await expect(
      adapter.requestFunds({
        chain: 'goat-testnet3',
        address: '0x1234567890abcdef1234567890abcdef12345678',
      }),
    ).rejects.toMatchObject({
      code: ErrorCodes.ADAPTER_REQUEST_FAILED,
      message: 'rate limited',
    });
  });
});
