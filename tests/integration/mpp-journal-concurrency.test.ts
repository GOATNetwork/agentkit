import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256, type Signer } from 'ethers';
import { ExecutionRuntime } from '../../core/runtime/execution-runtime';
import { PolicyEngine } from '../../core/policy/policy-engine';
import {
  PaykitService,
  paykitPayMppAction,
  FilePaymentRecoveryStore,
  InMemoryPaymentRecoveryStore,
} from '../../plugins/paykit';
import { manifest, ctx, URL, TOKEN, PAYTO, PAYER } from '../fixtures/paykit';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('MPP recovery overlapping an interrupted submission', () => {
  it.each(['memory', 'file'] as const)('keeps the receipt after a stale %s writer finishes', async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), 'mpp-concurrent-'));
    directories.push(directory);
    const memory = new InMemoryPaymentRecoveryStore();
    const store = () => (kind === 'memory' ? memory : new FilePaymentRecoveryStore(directory));
    const originalStore = store();
    const entered = deferred();
    const response = deferred();
    const hash = keccak256('0xdeadbeef');
    const receipt = `${Buffer.from(JSON.stringify({ merchant_id: 'acme', note: 'paid' })).toString('base64url')}.signature.HS256`;
    const signer = {
      getAddress: async () => PAYER,
      populateTransaction: async (tx: unknown) => tx,
      signTransaction: async () => '0xdeadbeef',
      provider: {
        getNetwork: async () => ({ chainId: 4217n }),
        broadcastTransaction: async () => {
          entered.resolve();
          await response.promise;
          return { hash };
        },
      },
    } as unknown as Signer;
    let verifies = 0;
    const fetchImpl: typeof fetch = async (url) => {
      if (String(url).endsWith('/manifest.json')) return Response.json(manifest);
      if (String(url).endsWith('/challenge'))
        return Response.json(
          {
            challenge_id: 'ch1',
            expiry: Math.floor(Date.now() / 1000) + 300,
            amount_wei: '1000000',
            chain_id: 4217,
            token_contract: TOKEN,
            recipient: PAYTO,
            mac: 'private',
            route_pricing_version: 1,
          },
          { status: 402 },
        );
      if (String(url).endsWith('/verify')) {
        verifies++;
        return new Response('{}', { status: 200, headers: { 'Payment-Receipt': receipt } });
      }
      throw new Error(`Unexpected request ${url}`);
    };
    const service = new PaykitService({ mppSigner: signer, fetchImpl, recoveryStore: originalStore });
    const runtime = new ExecutionRuntime(
      new PolicyEngine({ allowedNetworks: [ctx.network], writeEnabled: true, maxRiskWithoutConfirm: 'high' }),
      { logger: { log() {} } },
    );
    const controller = new AbortController();
    const pending = runtime.run(
      paykitPayMppAction(service),
      { ...ctx, signal: controller.signal },
      { url: URL, route: 'GET:api:data', idempotencyKey: 'race' },
      { confirmed: true },
    );
    await entered.promise;
    controller.abort();
    const interrupted = await pending;
    expect(interrupted.errorCode).toBe('ABORTED');
    const recovery = new PaykitService({ mppSigner: signer, fetchImpl, recoveryStore: store() });
    await expect(recovery.resumeMpp({ url: URL, operationId: 'race' }, ctx)).resolves.toMatchObject({
      receiptHeader: receipt,
    });
    expect(await originalStore.get('race')).toMatchObject({ phase: 'complete', result: { receiptHeader: receipt } });
    response.resolve();
    const final = await interrupted.settled;
    expect(final).toMatchObject({ phase: 'complete', result: { receiptHeader: receipt } });
    expect(await store().get('race')).toMatchObject({ phase: 'complete', result: { receiptHeader: receipt } });
    await recovery.resumeMpp({ url: URL, operationId: 'race' }, ctx);
    expect(verifies).toBe(1);
  });
});
