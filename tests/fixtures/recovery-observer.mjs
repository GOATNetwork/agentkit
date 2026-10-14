import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PaykitService } from '../../plugins/paykit/service.ts';
import { FilePaymentRecoveryStore } from '../../plugins/paykit/recovery.ts';
import { ExecutionRuntime } from '../../core/runtime/execution-runtime.ts';
import { PolicyEngine } from '../../core/policy/policy-engine.ts';
import { transferCheckpoints } from '../../core/wallet/checkpoints.ts';
import { notifyRecovery } from '../../core/runtime/recovery-observer.ts';

const hash = `0x${'44'.repeat(32)}`;
const token = `0x${'11'.repeat(20)}`;
const payer = `0x${'22'.repeat(20)}`;
const base = { traceId: 'async-observer', now: Date.now(), network: 'eip155:4217' };
const rejects = async (record) => {
  await new Promise((resolve) => setImmediate(resolve));
  record.operationId = 'observer-mutation';
  throw new Error('observer rejected');
};
const context = { ...base, checkpointRecovery: rejects };
const checkpoints = transferCheckpoints(context);
checkpoints.onSignedTransaction(hash);
checkpoints.onBroadcast(hash);

// Promise assimilation must consume a rejecting then getter under strict Node policy.
let thenReads = 0;
notifyRecovery(
  {
    checkpointRecovery: () => ({
      get then() {
        thenReads++;
        throw new Error('bad thenable');
      },
    }),
  },
  { kind: 'transaction', operationId: 'thenable', phase: 'broadcast' },
);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(thenReads, 1);

// A generic action calls the runtime wrapper directly, without the payment or wallet helper.
const runtime = new ExecutionRuntime(new PolicyEngine({ allowedNetworks: [base.network] }), { logger: { log() {} } });
const action = {
  name: 'test.observer',
  networks: [base.network],
  riskLevel: 'read',
  requiresConfirmation: false,
  description: 'Recovery observer probe',
  execute: async (ctx) => {
    ctx.checkpointRecovery({ kind: 'transaction', operationId: 'runtime-id', phase: 'broadcast', txHash: hash });
    await new Promise((resolve) => setImmediate(resolve));
    throw new Error('confirmation lost');
  },
};
const result = await runtime.run(action, context, {});
assert.equal(result.recovery.operationId, 'runtime-id');
assert.equal(result.recovery.txHash, hash);
let observerReads = 0;
const networkReceivers = [];
const getterContext = Object.defineProperties(
  { ...base },
  {
    checkpointRecovery: {
      enumerable: true,
      get() {
        observerReads++;
        throw new Error('observer accessor failed');
      },
    },
    network: {
      enumerable: true,
      get() {
        networkReceivers.push(this);
        return base.network;
      },
    },
  },
);
const getterResult = await runtime.run(action, getterContext, {});
assert.equal(getterResult.recovery.txHash, hash);
assert.equal(observerReads, 1);
assert.ok(networkReceivers.length > 0);
assert.ok(networkReceivers.every((receiver) => receiver === getterContext));

const directory = await mkdtemp(join(tmpdir(), 'agentkit-observer-'));
try {
  const recoveryStore = new FilePaymentRecoveryStore(directory);
  let sent = 0;
  const service = new PaykitService({
    recoveryStore,
    wallet: {
      getAddress: async () => payer,
      getChainId: async () => 4217,
      broadcastErc20: async (_token, _to, _amount, options) => {
        await options.onSignedTransaction(hash);
        sent++;
        return { txHash: hash };
      },
    },
    fetchImpl: async (url) => {
      if (String(url).endsWith('/manifest.json'))
        return Response.json({
          schema: 'goatx402.quickpay.v1',
          merchant: { merchant_id: 'acme', display_name: 'ACME' },
          rails: {
            x402: {
              enabled: true,
              tokens: [
                { chain_id: 4217, token_symbol: 'USDC', token_contract: token, decimals: 6, min_amount_wei: '1' },
              ],
            },
          },
        });
      if (String(url).endsWith('/sessions'))
        return Response.json({
          session_id: 's1',
          merchant_id: 'acme',
          status: 'ORDER_CREATED',
          expires_at: Math.floor(Date.now() / 1000) + 300,
          x402: {
            accepts: [{ scheme: 'exact', network: 'eip155:4217', asset: token, payTo: payer, amount: '1000000' }],
          },
        });
      return Response.json({
        session_id: 's1',
        merchant_id: 'acme',
        status: 'FAILED',
        tx_hash: hash,
        amount_wei: '1000000',
        chain_id: 4217,
        token_contract: token,
      });
    },
  });
  const error = await service
    .pay(
      {
        url: 'https://pay.example/paykit/acme',
        idempotencyKey: 'observer-id',
        chainId: 4217,
        tokenContract: token,
        amount: '1',
        pollTimeoutMs: 1000,
        pollIntervalMs: 1,
      },
      context,
    )
    .catch((e) => e);
  assert.ok(error.recovery, error.stack ?? JSON.stringify(error));
  assert.equal(error.recovery.txHash, hash);
  assert.equal(sent, 1);
  // Wait beyond the async observer's rejection and inspect the durable primary.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const stored = await new FilePaymentRecoveryStore(directory).get('observer-id');
  assert.equal(stored.phase, 'broadcast');
  assert.equal(stored.txHash, hash);
  assert.equal(stored.signedTxHash, hash);
  assert.equal(stored.operationId, 'observer-id');
  process.stdout.write('observer-recovery-ok\n');
} finally {
  await rm(directory, { recursive: true, force: true });
}
