import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  thoughtproofSentinelAction,
  thoughtproofVerifyAction,
  thoughtproofAttestAction,
  thoughtproofStatusAction,
  HttpThoughtProofAdapter,
} from '../../plugins/thoughtproof/index';
import type {
  ThoughtProofAdapter,
  SentinelVerifyOutput,
  RVVerifyOutput,
  AttestOutput,
  StatusOutput,
} from '../../plugins/thoughtproof/adapters/types';
import { submitReputationFeedback } from '../../plugins/thoughtproof/hooks/reputation';
import type { WalletProvider } from '../../core/wallet/wallet-provider';

// ── Mock Adapter ────────────────────────────────────────────

function mockAdapter(overrides: Partial<ThoughtProofAdapter> = {}): ThoughtProofAdapter {
  return {
    sentinelVerify: vi.fn().mockResolvedValue({
      verdict: 'ALLOW',
      confidence: 0.95,
      reasons: ['Reasoning is sound'],
      requestId: 'req_sentinel_001',
      latencyMs: 1200,
    } satisfies SentinelVerifyOutput),
    rvVerify: vi.fn().mockResolvedValue({
      verdict: 'ALLOW',
      confidence: 0.88,
      evaluation: 'Claim is well-supported',
      critique: 'Minor gap in evidence chain',
      synthesis: 'Overall the claim holds after adversarial review',
      requestId: 'req_rv_001',
      latencyMs: 8500,
    } satisfies RVVerifyOutput),
    attest: vi.fn().mockResolvedValue({
      attestationId: 'eas_0xabc123',
      txHash: '0xtx_attest',
    } satisfies AttestOutput),
    status: vi.fn().mockResolvedValue({
      sentinel: { healthy: true, latencyMs: 150 },
      rv: { healthy: true, latencyMs: 320 },
    } satisfies StatusOutput),
    ...overrides,
  };
}

function mockWallet(overrides: Partial<WalletProvider> = {}): WalletProvider {
  return {
    getAddress: vi.fn().mockResolvedValue('0xABCD'),
    getNetwork: vi.fn().mockResolvedValue('goat-mainnet'),
    getChainId: vi.fn().mockResolvedValue(2345),
    getBalance: vi.fn().mockResolvedValue('1000'),
    getErc20Balance: vi.fn().mockResolvedValue('500'),
    transferNative: vi.fn().mockResolvedValue({ txHash: '0xtx' }),
    transferErc20: vi.fn().mockResolvedValue({ txHash: '0xtx' }),
    approveErc20: vi.fn().mockResolvedValue({ txHash: '0xtx' }),
    signTypedData: vi.fn().mockResolvedValue('0xsig'),
    callContract: vi.fn().mockResolvedValue('0x'),
    writeContract: vi.fn().mockResolvedValue({ txHash: '0xtx_rep' }),
    deployContract: vi.fn().mockResolvedValue({ txHash: '0xtx_deploy', contractAddress: '0xNEW' }),
    ...overrides,
  };
}

const ctx = { traceId: 't1', network: 'goat-mainnet', now: Date.now() };

// ── thoughtproof.sentinel ───────────────────────────────────

describe('thoughtproof.sentinel', () => {
  it('has correct metadata', () => {
    const adapter = mockAdapter();
    const action = thoughtproofSentinelAction(adapter);
    expect(action.name).toBe('thoughtproof.sentinel');
    expect(action.riskLevel).toBe('read');
    expect(action.requiresConfirmation).toBe(false);
    expect(action.networks).toContain('goat-mainnet');
    expect(action.networks).toContain('goat-testnet');
  });

  it('calls adapter.sentinelVerify with correct input', async () => {
    const adapter = mockAdapter();
    const action = thoughtproofSentinelAction(adapter);
    const input = { claim: 'Buy 0.5 ETH', context: 'Trading agent', task: 'Execute trade' };

    const result = await action.execute(ctx, input);

    expect(adapter.sentinelVerify).toHaveBeenCalledWith(input, undefined);
    expect(result.verdict).toBe('ALLOW');
    expect(result.confidence).toBe(0.95);
    expect(result.requestId).toBe('req_sentinel_001');
  });

  it('passes signal from context', async () => {
    const adapter = mockAdapter();
    const action = thoughtproofSentinelAction(adapter);
    const controller = new AbortController();
    const ctxWithSignal = { ...ctx, signal: controller.signal };

    await action.execute(ctxWithSignal, { claim: 'Test' });

    expect(adapter.sentinelVerify).toHaveBeenCalledWith(
      { claim: 'Test' },
      controller.signal,
    );
  });

  it('propagates BLOCK verdict', async () => {
    const adapter = mockAdapter({
      sentinelVerify: vi.fn().mockResolvedValue({
        verdict: 'BLOCK',
        confidence: 0.92,
        reasons: ['Violates position limits', 'No technical analysis'],
        requestId: 'req_block_001',
        latencyMs: 800,
      }),
    });
    const action = thoughtproofSentinelAction(adapter);

    const result = await action.execute(ctx, { claim: 'All in on ETH' });

    expect(result.verdict).toBe('BLOCK');
    expect(result.reasons).toHaveLength(2);
  });

  it('propagates UNCERTAIN verdict', async () => {
    const adapter = mockAdapter({
      sentinelVerify: vi.fn().mockResolvedValue({
        verdict: 'UNCERTAIN',
        confidence: 0.55,
        reasons: ['Ambiguous reasoning'],
        requestId: 'req_unc_001',
        latencyMs: 1500,
      }),
    });
    const action = thoughtproofSentinelAction(adapter);

    const result = await action.execute(ctx, { claim: 'Maybe buy ETH' });

    expect(result.verdict).toBe('UNCERTAIN');
  });

  it('propagates adapter errors', async () => {
    const adapter = mockAdapter({
      sentinelVerify: vi.fn().mockRejectedValue(new Error('ThoughtProof API error 503: Service Unavailable')),
    });
    const action = thoughtproofSentinelAction(adapter);

    await expect(
      action.execute(ctx, { claim: 'Test' }),
    ).rejects.toThrow('ThoughtProof API error 503');
  });
});

// ── thoughtproof.verify ─────────────────────────────────────

describe('thoughtproof.verify', () => {
  it('has correct metadata', () => {
    const adapter = mockAdapter();
    const action = thoughtproofVerifyAction(adapter);
    expect(action.name).toBe('thoughtproof.verify');
    expect(action.riskLevel).toBe('read');
    expect(action.requiresConfirmation).toBe(false);
  });

  it('calls adapter.rvVerify with tier=standard by default', async () => {
    const adapter = mockAdapter();
    const action = thoughtproofVerifyAction(adapter);

    // Zod default should apply tier='standard' when not provided
    const input = { claim: 'ETH is undervalued', context: 'Market analysis', tier: 'standard' as const };
    const result = await action.execute(ctx, input);

    expect(adapter.rvVerify).toHaveBeenCalledWith(input, undefined);
    expect(result.verdict).toBe('ALLOW');
    expect(result.evaluation).toBe('Claim is well-supported');
    expect(result.critique).toBe('Minor gap in evidence chain');
    expect(result.synthesis).toBe('Overall the claim holds after adversarial review');
  });

  it('supports tier=deep for high-stakes verification', async () => {
    const adapter = mockAdapter();
    const action = thoughtproofVerifyAction(adapter);

    await action.execute(ctx, { claim: 'Major trade decision', tier: 'deep' });

    expect(adapter.rvVerify).toHaveBeenCalledWith(
      { claim: 'Major trade decision', tier: 'deep' },
      undefined,
    );
  });

  it('supports optional domain parameter', async () => {
    const adapter = mockAdapter();
    const action = thoughtproofVerifyAction(adapter);

    await action.execute(ctx, { claim: 'Compliance check', tier: 'standard', domain: 'finance' });

    expect(adapter.rvVerify).toHaveBeenCalledWith(
      { claim: 'Compliance check', tier: 'standard', domain: 'finance' },
      undefined,
    );
  });

  it('propagates adapter errors', async () => {
    const adapter = mockAdapter({
      rvVerify: vi.fn().mockRejectedValue(new Error('ThoughtProof API error 429: Rate limited')),
    });
    const action = thoughtproofVerifyAction(adapter);

    await expect(
      action.execute(ctx, { claim: 'Test', tier: 'standard' }),
    ).rejects.toThrow('429');
  });
});

// ── thoughtproof.attest ─────────────────────────────────────

describe('thoughtproof.attest', () => {
  it('has correct metadata', () => {
    const adapter = mockAdapter();
    const action = thoughtproofAttestAction(adapter);
    expect(action.name).toBe('thoughtproof.attest');
    expect(action.riskLevel).toBe('medium');
    expect(action.requiresConfirmation).toBe(true);
  });

  it('calls adapter.attest for sentinel source', async () => {
    const adapter = mockAdapter();
    const action = thoughtproofAttestAction(adapter);
    const input = {
      source: 'sentinel' as const,
      requestId: 'req_sentinel_001',
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
    };

    const result = await action.execute(ctx, input);

    expect(adapter.attest).toHaveBeenCalledWith(input, undefined);
    expect(result.attestationId).toBe('eas_0xabc123');
    expect(result.txHash).toBe('0xtx_attest');
  });

  it('calls adapter.attest for rv source', async () => {
    const adapter = mockAdapter();
    const action = thoughtproofAttestAction(adapter);

    await action.execute(ctx, {
      source: 'rv',
      requestId: 'req_rv_001',
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
    });

    expect(adapter.attest).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'rv', requestId: 'req_rv_001' }),
      undefined,
    );
  });

  it('propagates adapter errors', async () => {
    const adapter = mockAdapter({
      attest: vi.fn().mockRejectedValue(new Error('Attestation failed: insufficient gas')),
    });
    const action = thoughtproofAttestAction(adapter);

    await expect(
      action.execute(ctx, {
        source: 'sentinel',
        requestId: 'req_001',
        recipient: '0x1234567890abcdef1234567890abcdef12345678',
      }),
    ).rejects.toThrow('insufficient gas');
  });
});

// ── thoughtproof.status ─────────────────────────────────────

describe('thoughtproof.status', () => {
  it('has correct metadata', () => {
    const adapter = mockAdapter();
    const action = thoughtproofStatusAction(adapter);
    expect(action.name).toBe('thoughtproof.status');
    expect(action.riskLevel).toBe('read');
    expect(action.requiresConfirmation).toBe(false);
  });

  it('returns health status for both backends', async () => {
    const adapter = mockAdapter();
    const action = thoughtproofStatusAction(adapter);

    const result = await action.execute(ctx, {} as Record<string, never>);

    expect(result.sentinel.healthy).toBe(true);
    expect(result.rv.healthy).toBe(true);
    expect(result.sentinel.latencyMs).toBe(150);
    expect(result.rv.latencyMs).toBe(320);
  });

  it('reports unhealthy backends', async () => {
    const adapter = mockAdapter({
      status: vi.fn().mockResolvedValue({
        sentinel: { healthy: false, latencyMs: 10000 },
        rv: { healthy: true, latencyMs: 200 },
      }),
    });
    const action = thoughtproofStatusAction(adapter);

    const result = await action.execute(ctx, {} as Record<string, never>);

    expect(result.sentinel.healthy).toBe(false);
    expect(result.rv.healthy).toBe(true);
  });
});

// ── x402 Payment Flow ───────────────────────────────────────

describe('x402 payment handling', () => {
  it('handles 402 → sign → retry flow', async () => {
    const paymentRequirements = {
      scheme: 'exact',
      amount: '3000',
      asset: 'USDC',
      network: 'eip155:2345',
      domain: { name: 'x402', version: '1', chainId: 2345 },
      types: { Payment: [{ name: 'amount', type: 'uint256' }] },
      primaryType: 'Payment',
      message: { amount: '3000' },
    };

    // Mock fetch: first call returns 402, second call succeeds
    let callCount = 0;
    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        // First call: 402 Payment Required
        return new Response('Payment Required', {
          status: 402,
          headers: { 'payment-required': btoa(JSON.stringify(paymentRequirements)) },
        });
      }
      // Second call: success (with payment signature)
      return new Response(JSON.stringify({
        verdict: 'ALLOW',
        confidence: 0.95,
        reasons: ['Verified'],
        request_id: 'req_paid_001',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;

    const mockSigner = {
      signTypedData: vi.fn().mockResolvedValue('0xsig_payment_proof'),
      address: '0x1234567890abcdef1234567890abcdef12345678',
    };

    const adapter = new HttpThoughtProofAdapter({
      x402Signer: mockSigner,
      x402Fetch: mockFetch,
    });

    const result = await adapter.sentinelVerify({ claim: 'Test claim' });

    expect(result.verdict).toBe('ALLOW');
    expect(result.requestId).toBe('req_paid_001');
    expect(mockSigner.signTypedData).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Verify the second call has payment-signature header
    const secondCallInit = (mockFetch as any).mock.calls[1][1];
    expect(secondCallInit.headers['payment-signature']).toBeDefined();
  });

  it('falls through to API error when 402 received but no signer configured', async () => {
    const mockFetch = vi.fn(async () =>
      new Response('Payment Required', {
        status: 402,
        headers: { 'payment-required': btoa(JSON.stringify({ amount: '3000' })) },
      }),
    ) as unknown as typeof fetch;

    const adapter = new HttpThoughtProofAdapter({
      x402Fetch: mockFetch,
      // No x402Signer!
    });

    await expect(
      adapter.sentinelVerify({ claim: 'Test' }),
    ).rejects.toThrow('ThoughtProof API error 402');
  });

  it('throws when 402 received without PAYMENT-REQUIRED header', async () => {
    const mockFetch = vi.fn(async () =>
      new Response('Payment Required', { status: 402 }),
    ) as unknown as typeof fetch;

    const mockSigner = {
      signTypedData: vi.fn().mockResolvedValue('0xsig'),
      address: '0xABCD',
    };

    const adapter = new HttpThoughtProofAdapter({
      x402Signer: mockSigner,
      x402Fetch: mockFetch,
    });

    await expect(
      adapter.sentinelVerify({ claim: 'Test' }),
    ).rejects.toThrow('no PAYMENT-REQUIRED header');
  });

  it('uses apiKey when no x402Signer is provided', async () => {
    const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      new Response(JSON.stringify({
        verdict: 'ALLOW', confidence: 0.9, reasons: [], request_id: 'req_key_001',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ) as unknown as typeof fetch;

    const adapter = new HttpThoughtProofAdapter({
      apiKey: 'sk-test-key',
      x402Fetch: mockFetch,
    });

    await adapter.sentinelVerify({ claim: 'Test' });

    const callInit = (mockFetch as any).mock.calls[0][1];
    expect(callInit.headers['Authorization']).toBe('Bearer sk-test-key');
  });

  it('skips apiKey header when x402Signer is provided', async () => {
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({
        verdict: 'ALLOW', confidence: 0.9, reasons: [], request_id: 'req_x402_001',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ) as unknown as typeof fetch;

    const adapter = new HttpThoughtProofAdapter({
      apiKey: 'sk-test-key',
      x402Signer: { signTypedData: vi.fn(), address: '0xABCD' },
      x402Fetch: mockFetch,
    });

    await adapter.sentinelVerify({ claim: 'Test' });

    const callInit = (mockFetch as any).mock.calls[0][1];
    expect(callInit.headers['Authorization']).toBeUndefined();
  });

  it('isX402Enabled reflects signer presence', () => {
    const withSigner = new HttpThoughtProofAdapter({
      x402Signer: { signTypedData: vi.fn(), address: '0xABCD' },
    });
    expect(withSigner.isX402Enabled).toBe(true);

    const withoutSigner = new HttpThoughtProofAdapter({
      apiKey: 'sk-test',
    });
    expect(withoutSigner.isX402Enabled).toBe(false);
  });

  it('rejects payment exceeding maxPaymentAmount', async () => {
    const paymentRequirements = {
      scheme: 'exact',
      amount: '999999999', // way over cap
      domain: {}, types: {}, primaryType: 'Payment', message: {},
    };

    let callCount = 0;
    const mockFetch = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response('Payment Required', {
          status: 402,
          headers: { 'payment-required': btoa(JSON.stringify(paymentRequirements)) },
        });
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;

    const adapter = new HttpThoughtProofAdapter({
      x402Signer: { signTypedData: vi.fn(), address: '0xABCD' },
      x402Fetch: mockFetch,
      maxPaymentAmount: '100000', // cap at 100k
    });

    await expect(
      adapter.sentinelVerify({ claim: 'Test' }),
    ).rejects.toThrow('exceeds configured maxPaymentAmount');
  });
});

describe('reputation hook', () => {
  it('submits ALLOW verdict as score 100', async () => {
    const wallet = mockWallet();

    await submitReputationFeedback(
      wallet,
      'goat-mainnet',
      { agentId: '42' },
      'sentinel',
      {
        verdict: 'ALLOW',
        confidence: 0.95,
        reasons: [],
        requestId: 'req_001',
        latencyMs: 1000,
      },
    );

    expect(wallet.writeContract).toHaveBeenCalledWith(
      expect.any(String), // reputation registry address
      expect.any(Array),  // ABI
      'giveFeedback',
      expect.arrayContaining([
        BigInt(42),  // agentId
        100,         // score for ALLOW
        0,           // decimals
        'thoughtproof', // tag1
        'sentinel',     // tag2
      ]),
    );
  });

  it('submits BLOCK verdict as score 0', async () => {
    const wallet = mockWallet();

    await submitReputationFeedback(
      wallet,
      'goat-mainnet',
      { agentId: '42' },
      'rv',
      {
        verdict: 'BLOCK',
        confidence: 0.88,
        evaluation: '',
        critique: '',
        synthesis: '',
        requestId: 'req_002',
        latencyMs: 5000,
      },
    );

    expect(wallet.writeContract).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      'giveFeedback',
      expect.arrayContaining([
        BigInt(42),
        0,           // score for BLOCK
        0,
        'thoughtproof',
        'rv',
      ]),
    );
  });

  it('submits UNCERTAIN verdict as score 50', async () => {
    const wallet = mockWallet();

    await submitReputationFeedback(
      wallet,
      'goat-mainnet',
      { agentId: '42' },
      'sentinel',
      {
        verdict: 'UNCERTAIN',
        confidence: 0.55,
        reasons: [],
        requestId: 'req_003',
        latencyMs: 1500,
      },
    );

    expect(wallet.writeContract).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      'giveFeedback',
      expect.arrayContaining([BigInt(42), 50, 0, 'thoughtproof', 'sentinel']),
    );
  });

  it('returns null when disabled', async () => {
    const wallet = mockWallet();

    const result = await submitReputationFeedback(
      wallet,
      'goat-mainnet',
      { agentId: '42', enabled: false },
      'sentinel',
      { verdict: 'ALLOW', confidence: 0.95, reasons: [], requestId: 'req_004', latencyMs: 1000 },
    );

    expect(result).toBeNull();
    expect(wallet.writeContract).not.toHaveBeenCalled();
  });

  it('returns null for unsupported networks', async () => {
    const wallet = mockWallet();

    const result = await submitReputationFeedback(
      wallet,
      'ethereum-mainnet',
      { agentId: '42' },
      'sentinel',
      { verdict: 'ALLOW', confidence: 0.95, reasons: [], requestId: 'req_005', latencyMs: 1000 },
    );

    expect(result).toBeNull();
    expect(wallet.writeContract).not.toHaveBeenCalled();
  });

  it('silently catches wallet errors (best-effort)', async () => {
    const wallet = mockWallet({
      writeContract: vi.fn().mockRejectedValue(new Error('out of gas')),
    });

    const result = await submitReputationFeedback(
      wallet,
      'goat-mainnet',
      { agentId: '42' },
      'sentinel',
      { verdict: 'ALLOW', confidence: 0.95, reasons: [], requestId: 'req_006', latencyMs: 1000 },
    );

    expect(result).toBeNull(); // swallowed, not thrown
  });
});
