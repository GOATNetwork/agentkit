import { describe, expect, it, vi } from 'vitest';
import { keccak256, makeError, type Provider, type Signer, type TransactionResponse } from 'ethers';
import { EvmWalletProvider } from '../../core/wallet/evm-wallet-provider';
import { EvmPayerWalletAdapter } from '../../plugins/x402/adapters/evm-payer-wallet';
import { ExecutionRuntime } from '../../core/runtime/execution-runtime';
import { PolicyEngine } from '../../core/policy/policy-engine';
import { transferNativeAction } from '../../plugins/wallet/actions/transfer-native';
import type { WalletCallOptions } from '../../core/wallet/wallet-provider';
import { TOKEN, PAYER, PAYTO, HASH, ctx } from '../fixtures/paykit';

const REPLACEMENT = `0x${'55'.repeat(32)}`;
const CONTRACT = `0x${'66'.repeat(20)}`;

/** ethers v6 rejects wait() with this error for every replacement reason. */
function replaced(reason: 'repriced' | 'cancelled' | 'replaced', status = 1) {
  return makeError('transaction was replaced', 'TRANSACTION_REPLACED', {
    cancelled: reason !== 'repriced',
    reason,
    replacement: {} as never,
    hash: REPLACEMENT,
    receipt: { hash: REPLACEMENT, status, contractAddress: CONTRACT } as never,
  });
}

function wallet(wait: () => Promise<unknown>) {
  const tx = { hash: HASH, from: PAYER, nonce: 0, wait: vi.fn(wait) };
  const provider = {
    broadcastTransaction: vi.fn(async () => tx as unknown as TransactionResponse),
  } as unknown as Provider;
  const signer = {
    provider,
    getAddress: async () => PAYER,
    populateTransaction: vi.fn(async (request) => request),
    signTransaction: vi.fn(async () => '0xdeadbeef'),
  } as unknown as Signer;
  return { core: new EvmWalletProvider(signer, provider), legacy: new EvmPayerWalletAdapter(signer) };
}

const kinds = ['native', 'erc20', 'approve', 'write', 'deploy', 'legacy'] as const;
function send(kind: (typeof kinds)[number], test: ReturnType<typeof wallet>, options: WalletCallOptions) {
  switch (kind) {
    case 'native':
      return test.core.transferNative(PAYTO, '1', options);
    case 'erc20':
      return test.core.transferErc20(TOKEN, PAYTO, '1', options);
    case 'approve':
      return test.core.approveErc20(TOKEN, PAYTO, '1', options);
    case 'write':
      return test.core.writeContract(TOKEN, ['function pay() payable'], 'pay', [], '1', options);
    case 'deploy':
      return test.core.deployContract(['constructor() payable'], '0x6080', [], '1', options);
    case 'legacy':
      return test.legacy.transferToken({ tokenAddress: TOKEN, to: PAYTO, amount: '1' }, undefined, options);
  }
}

describe('ethers transaction replacement', () => {
  it.each(kinds)('%s follows a repriced fee bump to the mined replacement', async (kind) => {
    const onBroadcast = vi.fn();
    const result = await send(
      kind,
      wallet(async () => {
        throw replaced('repriced');
      }),
      { onBroadcast },
    );
    expect(result).toMatchObject({ txHash: REPLACEMENT, ...(kind === 'deploy' ? { contractAddress: CONTRACT } : {}) });
    expect(onBroadcast.mock.calls).toEqual([[HASH], [REPLACEMENT]]);
  });

  it.each(
    kinds.flatMap((kind) =>
      (
        [
          ['cancelled', 1, 'cancelled or replaced with a different call'],
          ['replaced', 1, 'cancelled or replaced with a different call'],
          ['repriced', 0, 'Transaction reverted'],
        ] as const
      ).map(([reason, status, message]) => ({ kind, reason, status, message })),
    ),
  )('$kind reports a $reason replacement (status $status) against the replacement hash', async (c) => {
    const onBroadcast = vi.fn();
    const error = await send(
      c.kind,
      wallet(async () => {
        throw replaced(c.reason, c.status);
      }),
      { onBroadcast },
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'WALLET_TRANSFER_FAILED',
      message: expect.stringContaining(c.message),
      recovery: { phase: 'broadcast', txHash: REPLACEMENT, operationId: REPLACEMENT },
    });
    expect(onBroadcast.mock.calls).toEqual([[HASH], [REPLACEMENT]]);
  });

  it('keeps other confirmation failures attributed to the broadcast hash', async () => {
    const error = await send(
      'erc20',
      wallet(async () => {
        throw makeError('transaction execution reverted', 'CALL_EXCEPTION', {
          action: 'sendTransaction',
          data: null,
          reason: null,
          invocation: null,
          revert: null,
          transaction: { to: null, data: '0x' },
          receipt: { status: 0 } as never,
        });
      }),
      {},
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'WALLET_TRANSFER_FAILED',
      message: 'Transaction confirmation incomplete; inspect the broadcast hash before retrying',
      recovery: { txHash: HASH },
    });
  });

  it.each([
    ['repriced', true],
    ['cancelled', false],
  ] as const)('runtime reports a %s native transfer with its replacement evidence', async (reason, ok) => {
    const test = wallet(async () => {
      throw replaced(reason);
    });
    const runtime = new ExecutionRuntime(
      new PolicyEngine({ allowedNetworks: ['goat-testnet'], maxRiskWithoutConfirm: 'high', writeEnabled: true }),
      { logger: { log() {} } },
    );
    const result = await runtime.run(
      transferNativeAction(test.core),
      { ...ctx, network: 'goat-testnet' },
      { to: PAYTO, amountWei: '1' },
      { confirmed: true, idempotencyKey: `replacement-${reason}` },
    );
    expect(result.ok).toBe(ok);
    if (ok) expect(result.output).toMatchObject({ txHash: REPLACEMENT });
    else
      expect(result.recovery).toMatchObject({
        operationId: `replacement-${reason}`,
        phase: 'broadcast',
        txHash: REPLACEMENT,
        signedTxHash: keccak256('0xdeadbeef'),
      });
  });
});
