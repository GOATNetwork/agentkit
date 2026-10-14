import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonRpcProvider, Wallet } from 'ethers';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runPaykitCli } from '../../bin/_lib/cli-paykit';
import { confirm } from '../../bin/_lib/confirmations';
import {
  FilePaymentRecoveryStore,
  paymentFingerprint,
  paymentRequestKey,
  type PaymentRecovery,
} from '../../plugins/paykit/recovery';
import { HASH, TOKEN, PAYTO, manifest, session } from '../fixtures/paykit';
import { AgentkitRuntimeError } from '../../core/errors/error';
import { ErrorCodes } from '../../core/errors/error-codes';

// Approved payments get an RPC provider that only reports its chain; any other
// use (nonce, gas, signing, broadcast) is recorded as reaching the signer path.
const providerState = vi.hoisted(() => ({ create: undefined as undefined | (() => unknown) }));
vi.mock('ethers', async (original) => ({
  ...(await original<typeof import('ethers')>()),
  JsonRpcProvider: vi.fn(function () {
    if (!providerState.create) throw new Error('Provider must not be constructed before payment approval');
    return providerState.create();
  }),
}));
vi.mock('../../bin/_lib/confirmations', async (original) => ({
  ...(await original<typeof import('../../bin/_lib/confirmations')>()),
  confirm: vi.fn(async () => false),
}));

afterEach(() => {
  providerState.create = undefined;
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function chainOnlyProvider(touched: string[]) {
  return new Proxy(
    {},
    {
      get: (_target, property) => {
        if (property === 'getNetwork') return async () => ({ chainId: 4217n });
        if (property === 'destroy') return () => {};
        if (property === 'then' || typeof property === 'symbol') return undefined;
        return (..._args: unknown[]) => {
          touched.push(property);
          throw new Error(`provider.${property} must not be used`);
        };
      },
    },
  );
}

const repricedManifest = {
  ...manifest,
  rails: {
    ...manifest.rails,
    x402: { ...manifest.rails.x402, products: [{ product_key: 'mug', name: 'Mug', price: '100' }] },
    mpp: { ...manifest.rails.mpp, routes: [{ ...manifest.rails.mpp.routes[0], amount_wei: '100000000' }] },
  },
};

const requestUrl = (input: unknown) => String(input instanceof Request ? input.url : input);

describe('PayKit payment approval', () => {
  it.each([
    ['pay-x402', ['--token', 'USDC', '--amount', '1'], 'Pay 1 USDC on eip155:4217', 0],
    ['pay-product', ['--token', 'USDC', '--product', 'mug'], 'Buy product mug for 1 USDC on eip155:4217', 1],
    ['pay-mpp', ['--route', 'GET:api:data'], 'Pay MPP route GET:api:data for 1.0 USDC (1000000 base units)', 1],
  ] as const)(
    'shows the payer and quoted terms, and does not construct an RPC provider when %s is declined',
    async (command, args, terms, quoteRequests) => {
      for (const [variable, expected] of [
        ['PAYKIT_PRIVATE_KEY', 'PAYKIT_PRIVATE_KEY'],
        ['GOAT_PRIVATE_KEY', 'GOAT_PRIVATE_KEY'],
      ] as const) {
        vi.clearAllMocks();
        vi.unstubAllEnvs();
        const key = `0x${'01'.repeat(32)}`;
        vi.stubEnv('PAYKIT_PRIVATE_KEY', variable === 'PAYKIT_PRIVATE_KEY' ? key : '');
        vi.stubEnv('GOAT_PRIVATE_KEY', variable === 'GOAT_PRIVATE_KEY' ? key : '');
        vi.stubEnv('PAYKIT_EMERGENCY_DIR', '');
        const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
        // Only the read-only merchant quote may run before approval.
        const fetchImpl = vi.fn(async (input: unknown) =>
          requestUrl(input).endsWith('/manifest.json')
            ? Response.json(manifest)
            : new Response('unexpected', { status: 500 }),
        );
        vi.stubGlobal('fetch', fetchImpl);
        const code = await runPaykitCli([
          'node',
          'paykit',
          '--state-dir',
          join(tmpdir(), 'unused-declined-paykit'),
          '--rpc-url',
          'http://127.0.0.1:1234',
          '--json',
          command,
          'https://pay.example/paykit/acme',
          '--chain-id',
          '4217',
          '--idempotency-key',
          'declined',
          ...args,
        ]);
        expect(code).toBe(4);
        expect(confirm).toHaveBeenCalledTimes(1);
        const prompt = vi.mocked(confirm).mock.calls[0][0];
        expect(prompt).toContain(terms);
        expect(prompt).toContain(`from ${new Wallet(key).address} (${expected})`);
        expect(prompt).toContain('idempotency key declined');
        expect(stdout).toHaveBeenCalledWith(expect.stringContaining('Payment declined'));
        expect(JsonRpcProvider).not.toHaveBeenCalled();
        expect(fetchImpl.mock.calls.map(([input]) => requestUrl(input))).toEqual(
          Array.from({ length: quoteRequests }, () => expect.stringMatching(/\/manifest\.json$/)),
        );
        stdout.mockRestore();
      }
    },
  );

  it('neutralizes control and bidi characters in merchant quote text', async () => {
    vi.stubEnv('PAYKIT_PRIVATE_KEY', `0x${'01'.repeat(32)}`);
    vi.stubEnv('PAYKIT_EMERGENCY_DIR', '');
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const spoofed = 'USDC\u001b[2K\rPay 0 USDC‮';
    const quoted = {
      ...manifest,
      rails: {
        ...manifest.rails,
        mpp: {
          ...manifest.rails.mpp,
          routes: [{ ...manifest.rails.mpp.routes[0], token_symbol: spoofed }],
        },
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(quoted)),
    );
    const code = await runPaykitCli([
      'node',
      'paykit',
      '--state-dir',
      join(tmpdir(), 'unused-declined-paykit'),
      '--rpc-url',
      'http://127.0.0.1:1234',
      '--json',
      'pay-mpp',
      'https://pay.example/paykit/acme',
      '--chain-id',
      '4217',
      '--idempotency-key',
      'spoofed',
      '--route',
      'GET:api:data',
    ]);
    expect(code).toBe(4);
    const prompt = vi.mocked(confirm).mock.calls[0][0];
    expect(prompt).toContain('1000000 base units of USDC?[2K?Pay 0 USDC?');
    expect(prompt).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  });

  it('does not pay when the quote cannot be loaded before approval', async () => {
    vi.stubEnv('PAYKIT_PRIVATE_KEY', `0x${'01'.repeat(32)}`);
    vi.stubEnv('PAYKIT_EMERGENCY_DIR', '');
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const fetchImpl = vi.fn(async () => new Response('unavailable', { status: 503 }));
    vi.stubGlobal('fetch', fetchImpl);
    const code = await runPaykitCli([
      'node',
      'paykit',
      '--state-dir',
      join(tmpdir(), 'unused-declined-paykit'),
      '--rpc-url',
      'http://127.0.0.1:1234',
      '--json',
      'pay-mpp',
      'https://pay.example/paykit/acme',
      '--chain-id',
      '4217',
      '--idempotency-key',
      'quote-unavailable',
      '--route',
      'GET:api:data',
    ]);
    expect(code).toBe(10);
    expect(confirm).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('no payment was sent'));
    expect(JsonRpcProvider).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls.every(([input]) => requestUrl(input).endsWith('/manifest.json'))).toBe(true);
  });

  it.each([
    ['pay-product', ['--token', 'USDC', '--product', 'mug'], 'for 1 USDC'],
    ['pay-mpp', ['--route', 'GET:api:data'], 'for 1.0 USDC (1000000 base units)'],
  ] as const)('executes %s only against the approved quote', async (command, args, approvedTerms) => {
    vi.stubEnv('PAYKIT_PRIVATE_KEY', `0x${'01'.repeat(32)}`);
    vi.stubEnv('PAYKIT_EMERGENCY_DIR', '');
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const touched: string[] = [];
    providerState.create = () => chainOnlyProvider(touched);
    vi.mocked(confirm).mockResolvedValueOnce(true);
    // The merchant raises every price immediately after the quoted manifest read.
    let manifestReads = 0;
    const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.endsWith('/manifest.json')) return Response.json(manifestReads++ === 0 ? manifest : repricedManifest);
      if (url.endsWith('/quickpay/v1/x402/sessions') && init?.method === 'POST')
        return Response.json(
          session({
            x402: {
              accepts: [{ scheme: 'exact', network: 'eip155:4217', asset: TOKEN, payTo: PAYTO, amount: '100000000' }],
            },
          }),
        );
      if (url.endsWith('/mpp/v1/challenge'))
        return Response.json(
          {
            challenge_id: 'ch1',
            expiry: Math.floor(Date.now() / 1000) + 300,
            amount_wei: '100000000',
            chain_id: 4217,
            token_contract: TOKEN,
            recipient: PAYTO,
            mac: 'private-mac',
            route_pricing_version: 2,
          },
          { status: 402 },
        );
      return new Response('unexpected', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchImpl);
    const stateDir = await mkdtemp(join(tmpdir(), 'paykit-approved-quote-'));
    try {
      const code = await runPaykitCli([
        'node',
        'paykit',
        '--state-dir',
        stateDir,
        '--rpc-url',
        'http://127.0.0.1:1234',
        '--json',
        command,
        'https://pay.example/paykit/acme',
        '--chain-id',
        '4217',
        '--idempotency-key',
        'approved',
        ...args,
      ]);
      expect(vi.mocked(confirm).mock.calls[0][0]).toContain(approvedTerms);
      expect(code).toBe(10);
      expect(manifestReads).toBe(1);
      expect(touched).toEqual([]);
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining('ADAPTER_REQUEST_FAILED'));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  const scenarios = ['completed', 'requesting marker', 'conflicting marker', 'corrupt primary'] as const;
  it.each(
    (['pay-product', 'pay-mpp'] as const).flatMap((command) => scenarios.map((journal) => ({ command, journal }))),
  )('handles a $journal $command intent without a live merchant quote', async ({ command, journal }) => {
    const key = `0x${'01'.repeat(32)}`;
    const payer = new Wallet(key).address;
    vi.stubEnv('PAYKIT_PRIVATE_KEY', key);
    vi.stubEnv('PAYKIT_EMERGENCY_DIR', '');
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const touched: string[] = [];
    providerState.create = () => chainOnlyProvider(touched);
    vi.mocked(confirm).mockResolvedValueOnce(true);
    const fetchImpl = vi.fn(async () => new Response('merchant unavailable', { status: 503 }));
    vi.stubGlobal('fetch', fetchImpl);
    const origin = 'https://pay.example';
    const base = {
      kind: 'paykit',
      operationId: 'saved',
      phase: 'prepared',
      origin,
      merchantId: 'acme',
      payer,
    } as const;
    const primary: PaymentRecovery =
      command === 'pay-mpp'
        ? {
            ...base,
            rail: 'mpp',
            chainId: 4217,
            route: 'GET:api:data',
            fingerprint: paymentFingerprint([
              origin,
              'acme',
              'mpp',
              payer.toLowerCase(),
              'GET:api:data',
              4217,
              undefined,
            ]),
          }
        : {
            ...base,
            rail: 'x402',
            chainId: 4217,
            fingerprint: paymentFingerprint([
              origin,
              'acme',
              payer.toLowerCase(),
              4217,
              undefined,
              'USDC',
              undefined,
              'mug',
              undefined,
            ]),
          };
    const stateDir = await mkdtemp(join(tmpdir(), 'paykit-journaled-'));
    try {
      const store = new FilePaymentRecoveryStore(stateDir);
      // An invalid chain ID is stored-data corruption that execution also rejects.
      await store.claim(journal === 'corrupt primary' ? { ...primary, chainId: 0 } : primary);
      if (journal === 'corrupt primary') {
        // No marker: the corrupt primary alone stops execution.
      } else if (journal === 'completed')
        await store.put({
          ...primary,
          phase: 'complete',
          txHash: HASH,
          result:
            command === 'pay-mpp'
              ? {
                  receiptHeader: `${Buffer.from(JSON.stringify({ merchant_id: 'acme' })).toString('base64url')}.signature.HS256`,
                }
              : { ok: true, status: 'PAYMENT_CONFIRMED', tx_hash: HASH, session_id: 's1' },
        });
      // A crash after the request claim leaves the primary prepared and its marker ahead of it.
      else
        await store.claim({
          ...primary,
          operationId: paymentRequestKey(primary),
          phase: 'requesting',
          ...(journal === 'conflicting marker' ? { fingerprint: 'f'.repeat(64) } : {}),
          ...(command === 'pay-mpp'
            ? {}
            : { sessionCreateBody: JSON.stringify({ chain_id: 4217, token_contract: TOKEN, product_key: 'mug' }) }),
        });
      const code = await runPaykitCli([
        'node',
        'paykit',
        '--state-dir',
        stateDir,
        '--rpc-url',
        'http://127.0.0.1:1234',
        '--json',
        command,
        `${origin}/paykit/acme`,
        '--chain-id',
        '4217',
        '--idempotency-key',
        'saved',
        ...(command === 'pay-mpp' ? ['--route', 'GET:api:data'] : ['--token', 'USDC', '--product', 'mug']),
      ]);
      expect(vi.mocked(confirm).mock.calls[0][0]).toContain(
        journal === 'conflicting marker' || journal === 'corrupt primary'
          ? 'return or recover the journaled intent saved, which needs reconciliation; no new payment is sent'
          : `return or recover the journaled ${primary.rail} intent saved (${journal === 'completed' ? 'complete' : 'requesting'}); no new payment is sent`,
      );
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(touched).toEqual([]);
      if (journal === 'completed') {
        expect(code).toBe(0);
        expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"ok": true'));
      } else {
        expect(code).toBe(10);
        expect(stdout).toHaveBeenCalledWith(expect.stringContaining('RECOVERY_REQUIRED'));
      }
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it.each([
    ['pay-product', ['--token', 'USDC', '--product', 'mug'], 'for 1 USDC'],
    ['pay-mpp', ['--route', 'GET:api:data'], 'for 1.0 USDC (1000000 base units)'],
  ] as const)('keeps the quoted approval when a %s marker read fails transiently', async (command, args, terms) => {
    const key = `0x${'01'.repeat(32)}`;
    const payer = new Wallet(key).address;
    vi.stubEnv('PAYKIT_PRIVATE_KEY', key);
    vi.stubEnv('PAYKIT_EMERGENCY_DIR', '');
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const fetchImpl = vi.fn(async (input: unknown) =>
      requestUrl(input).endsWith('/manifest.json')
        ? Response.json(manifest)
        : new Response('unexpected', { status: 500 }),
    );
    vi.stubGlobal('fetch', fetchImpl);
    // The first request-marker read fails with journal I/O; a later read (as
    // execution would do) succeeds and finds no marker, so a payment can start.
    const get = FilePaymentRecoveryStore.prototype.get;
    let failedMarkerReads = 0;
    vi.spyOn(FilePaymentRecoveryStore.prototype, 'get').mockImplementation(async function (
      this: FilePaymentRecoveryStore,
      id: string,
    ) {
      if (id.includes('-request:') && failedMarkerReads++ === 0)
        throw new AgentkitRuntimeError(ErrorCodes.ADAPTER_REQUEST_FAILED, 'Payment journal I/O failed');
      return get.call(this, id);
    });
    const origin = 'https://pay.example';
    const stateDir = await mkdtemp(join(tmpdir(), 'paykit-transient-'));
    try {
      await new FilePaymentRecoveryStore(stateDir).claim({
        kind: 'paykit',
        operationId: 'transient',
        phase: 'prepared',
        origin,
        merchantId: 'acme',
        payer,
        chainId: 4217,
        rail: command === 'pay-mpp' ? 'mpp' : 'x402',
        fingerprint: 'a'.repeat(64),
      });
      const code = await runPaykitCli([
        'node',
        'paykit',
        '--state-dir',
        stateDir,
        '--rpc-url',
        'http://127.0.0.1:1234',
        '--json',
        command,
        `${origin}/paykit/acme`,
        '--chain-id',
        '4217',
        '--idempotency-key',
        'transient',
        ...args,
      ]);
      expect(failedMarkerReads).toBeGreaterThan(0);
      const prompt = vi.mocked(confirm).mock.calls[0][0];
      expect(prompt).toContain(terms);
      expect(prompt).not.toContain('no new payment is sent');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(code).toBe(4);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
