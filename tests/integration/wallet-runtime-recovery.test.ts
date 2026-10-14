import { describe, expect, it, vi } from 'vitest';
import { Transaction, Wallet, type Provider, type TransactionReceipt } from 'ethers';
import { EvmWalletProvider } from '../../core/wallet/evm-wallet-provider';
import { transferNativeAction } from '../../plugins/wallet/actions/transfer-native';
import { ExecutionRuntime } from '../../core/runtime/execution-runtime';
import { InMemoryIdempotencyStore } from '../../core/runtime/idempotency/store';
import { PolicyEngine } from '../../core/policy/policy-engine';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function setup() {
  let nonce = 5;
  const accepted: Transaction[] = [];
  const waiting = deferred<void>();
  const wait = vi.fn(async (): Promise<TransactionReceipt | null> => {
    waiting.resolve();
    return new Promise(() => {});
  });
  const provider = {
    getNetwork: async () => ({ chainId: 4217n }),
    getTransactionCount: async () => nonce,
    getFeeData: async () => ({ gasPrice: 1n, maxFeePerGas: null, maxPriorityFeePerGas: null }),
    estimateGas: async () => 21000n,
    broadcastTransaction: vi.fn(async (raw: string) => {
      const tx = Transaction.from(raw);
      accepted.push(tx);
      nonce++;
      return { hash: tx.hash!, wait };
    }),
  };
  const signer = new Wallet(`0x${'11'.repeat(32)}`, provider as unknown as Provider);
  const action = transferNativeAction(new EvmWalletProvider(signer, provider as unknown as Provider));
  const store = new InMemoryIdempotencyStore();
  const runtime = () =>
    new ExecutionRuntime(
      new PolicyEngine({ allowedNetworks: ['goat-testnet'], maxRiskWithoutConfirm: 'high', writeEnabled: true }),
      { idempotencyStore: store, logger: { log: vi.fn() } },
    );
  return { action, runtime, store, accepted, provider, signer, wait, waiting };
}
const ctx = { traceId: 'wallet-recovery', network: 'goat-testnet', now: Date.now() };
const input = { to: `0x${'22'.repeat(20)}`, amountWei: '1' };
const options = { idempotencyKey: 'payment', confirmed: true };

describe('real wallet action runtime recovery', () => {
  it.each(['sync', 'async'] as const)('retains wallet evidence and the key when a %s observer fails', async (mode) => {
    const { action, runtime, accepted, wait } = setup();
    wait.mockRejectedValueOnce(new Error('confirmation unavailable'));
    const checkpointRecovery = vi.fn(() => {
      if (mode === 'async') return Promise.reject(new Error('observer failed'));
      throw new Error('observer failed');
    });
    const result = await runtime().run(action, { ...ctx, checkpointRecovery }, input, options);
    const recovery = await result.settled;
    expect(accepted).toHaveLength(1);
    expect(recovery).toMatchObject({
      operationId: 'payment',
      phase: 'broadcast',
      txHash: accepted[0].hash,
      signedTxHash: accepted[0].hash,
    });
    expect(checkpointRecovery).toHaveBeenCalledTimes(2);
    expect(await runtime().run(action, ctx, input, options)).toMatchObject({ errorCode: 'IDEMPOTENCY_CONFLICT' });
  });

  it.each(['abort', 'timeout', 'confirmation error', 'cache error'] as const)(
    'never re-executes a submitted payment after %s',
    async (failure) => {
      const { action, runtime, store, accepted, wait, waiting } = setup();
      const release = vi.spyOn(store, 'release');
      if (failure === 'confirmation error') wait.mockRejectedValueOnce(new Error('RPC unavailable'));
      if (failure === 'cache error') {
        wait.mockResolvedValueOnce(null);
        vi.spyOn(store, 'complete').mockRejectedValueOnce(new Error('cache unavailable'));
      }
      const controller = new AbortController();
      const run = runtime().run(action, { ...ctx, signal: controller.signal }, input, {
        ...options,
        ...(failure === 'timeout' ? { timeoutMs: 30 } : {}),
      });
      if (failure === 'abort') {
        await waiting.promise;
        controller.abort();
      }
      const result = await run;
      expect(result.ok).toBe(false);
      const recovery = await result.settled;
      expect(recovery).toMatchObject({ operationId: 'payment', phase: 'broadcast', txHash: accepted[0].hash });
      // A fresh runtime sharing the store must retain the protection as well.
      expect(await runtime().run(action, ctx, input, options)).toMatchObject({
        ok: false,
        errorCode: 'IDEMPOTENCY_CONFLICT',
        attempts: 0,
      });
      expect(release).not.toHaveBeenCalled();
      expect(accepted).toHaveLength(1);
    },
  );

  it('retains the key when the hash arrives only after the caller has stopped waiting', async () => {
    const { action, runtime, accepted, provider } = setup();
    const submitted = deferred<void>();
    const response = deferred<void>();
    const broadcast = provider.broadcastTransaction.getMockImplementation()!;
    provider.broadcastTransaction.mockImplementationOnce(async (raw) => {
      const tx = await broadcast(raw);
      submitted.resolve();
      await response.promise;
      return tx;
    });
    const controller = new AbortController();
    const pending = runtime().run(action, { ...ctx, signal: controller.signal }, input, options);
    await submitted.promise;
    controller.abort();
    const result = await pending;
    response.resolve();
    await result.settled;
    expect(await runtime().run(action, ctx, input, options)).toMatchObject({ errorCode: 'IDEMPOTENCY_CONFLICT' });
    expect(accepted).toHaveLength(1);
  });

  it('still releases a key when signing failed before transaction evidence existed', async () => {
    const { action, runtime, accepted, signer, wait } = setup();
    vi.spyOn(signer, 'signTransaction').mockRejectedValueOnce(new Error('signing refused'));
    const first = await runtime().run(action, ctx, input, options);
    await first.settled;
    expect(first.recovery).toBeUndefined();
    wait.mockResolvedValueOnce(null);
    expect(await runtime().run(action, ctx, input, options)).toMatchObject({ ok: true, attempts: 1 });
    expect(accepted).toHaveLength(1);
  });
});
