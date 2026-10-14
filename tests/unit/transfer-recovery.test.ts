import { describe, expect, it, vi } from 'vitest';
import { keccak256, type Provider, type Signer, type TransactionResponse } from 'ethers';
import { EvmWalletProvider } from '../../core/wallet/evm-wallet-provider';
import { EvmPayerWalletAdapter } from '../../plugins/x402/adapters/evm-payer-wallet';
import { ExecutionRuntime } from '../../core/runtime/execution-runtime';
import { PolicyEngine } from '../../core/policy/policy-engine';
import { WalletProviderPayerAdapter } from '../../core/wallet/compat';
import { transferNativeAction } from '../../plugins/wallet/actions/transfer-native';
import { transferPaymentAction } from '../../plugins/x402/actions/payment.transfer';
import { TOKEN, PAYER, PAYTO, HASH, ctx } from '../fixtures/paykit';

function wallet() {
  const wait = vi.fn(async () => ({ hash: HASH }));
  const broadcast = vi.fn(async () => ({ hash: HASH, wait }) as unknown as TransactionResponse);
  const provider = { broadcastTransaction: broadcast } as unknown as Provider;
  const populate = vi.fn(async (tx) => tx);
  const sign = vi.fn(async () => '0xdeadbeef');
  const signer = {
    provider,
    getAddress: async () => PAYER,
    populateTransaction: populate,
    signTransaction: sign,
  } as unknown as Signer;
  return {
    signer,
    provider,
    broadcast,
    populate,
    sign,
    wait,
    core: new EvmWalletProvider(signer, provider),
    legacy: new EvmPayerWalletAdapter(signer),
  };
}

describe('transfer submission recovery', () => {
  it.each(['rpc failure', 'confirmation abort'] as const)(
    'retains action identity and signed evidence after %s',
    async (failure) => {
      const test = wallet();
      const controller = new AbortController();
      if (failure === 'rpc failure') test.broadcast.mockRejectedValueOnce(new Error('submission response lost'));
      else
        test.broadcast.mockImplementationOnce(async () => {
          controller.abort();
          return { hash: HASH, wait: test.wait } as unknown as TransactionResponse;
        });
      const action = transferNativeAction(test.core);
      const runtime = new ExecutionRuntime(
        new PolicyEngine({ allowedNetworks: ['goat-testnet'], maxRiskWithoutConfirm: 'high', writeEnabled: true }),
      );
      const result = await runtime.run(
        action,
        { ...ctx, network: 'goat-testnet', signal: controller.signal },
        { to: PAYTO, amountWei: '1' },
        { confirmed: true, idempotencyKey: 'wallet-operation' },
      );
      const recovery = result.settled ? await result.settled : result.recovery;
      expect(recovery).toMatchObject({
        operationId: 'wallet-operation',
        signedTxHash: keccak256('0xdeadbeef'),
        phase: failure === 'rpc failure' ? 'submitting' : 'broadcast',
      });
      if (failure === 'confirmation abort') expect(recovery).toHaveProperty('txHash', HASH);
    },
  );

  it.each(['compat', 'legacy'] as const)(
    'honors options.signal when the %s positional signal is omitted',
    async (kind) => {
      const test = wallet();
      const controller = new AbortController();
      controller.abort();
      const adapter = kind === 'compat' ? new WalletProviderPayerAdapter(test.core) : test.legacy;
      await expect(
        adapter.transferToken({ tokenAddress: TOKEN, to: PAYTO, amount: '1' }, undefined, {
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ code: 'ABORTED' });
      expect(test.populate).not.toHaveBeenCalled();
      expect(test.broadcast).not.toHaveBeenCalled();
    },
  );

  it.each(['native', 'erc20', 'legacy', 'approve', 'write', 'deploy'] as const)(
    '%s transfer stops after cancelled preparation',
    async (kind) => {
      const test = wallet();
      const abort = new AbortController();
      test.populate.mockImplementationOnce(async (tx) => {
        abort.abort();
        return tx;
      });
      const result =
        kind === 'native'
          ? test.core.transferNative(PAYTO, '1', { signal: abort.signal })
          : kind === 'erc20'
            ? test.core.transferErc20(TOKEN, PAYTO, '1', { signal: abort.signal })
            : kind === 'approve'
              ? test.core.approveErc20(TOKEN, PAYTO, '1', { signal: abort.signal })
              : kind === 'write'
                ? test.core.writeContract(TOKEN, ['function pay() payable'], 'pay', [], '1', { signal: abort.signal })
                : kind === 'deploy'
                  ? test.core.deployContract(['constructor() payable'], '0x6080', [], '1', { signal: abort.signal })
                  : test.legacy.transferToken({ tokenAddress: TOKEN, to: PAYTO, amount: '1' }, abort.signal);
      await expect(result).rejects.toMatchObject({ code: 'ABORTED' });
      expect(test.broadcast).not.toHaveBeenCalled();
    },
  );

  it.each(['native', 'erc20', 'legacy', 'approve', 'write', 'deploy'] as const)(
    '%s transfer retains the late hash after abort',
    async (kind) => {
      const test = wallet();
      const abort = new AbortController();
      const tx = await test.broadcast();
      test.broadcast.mockClear().mockImplementationOnce(async () => {
        abort.abort();
        await Promise.resolve();
        return tx;
      });
      const checkpoint = vi.fn();
      const result =
        kind === 'native'
          ? test.core.transferNative(PAYTO, '1', { signal: abort.signal, onBroadcast: checkpoint })
          : kind === 'erc20'
            ? test.core.transferErc20(TOKEN, PAYTO, '1', { signal: abort.signal, onBroadcast: checkpoint })
            : kind === 'approve'
              ? test.core.approveErc20(TOKEN, PAYTO, '1', { signal: abort.signal, onBroadcast: checkpoint })
              : kind === 'write'
                ? test.core.writeContract(TOKEN, ['function pay() payable'], 'pay', [], '1', {
                    signal: abort.signal,
                    onBroadcast: checkpoint,
                  })
                : kind === 'deploy'
                  ? test.core.deployContract(['constructor() payable'], '0x6080', [], '1', {
                      signal: abort.signal,
                      onBroadcast: checkpoint,
                    })
                  : transferPaymentAction(test.legacy).execute(
                      { ...ctx, signal: abort.signal, checkpointRecovery: checkpoint },
                      { tokenAddress: TOKEN, to: PAYTO, amount: '1' },
                    );
      await expect(result).rejects.toMatchObject({ code: 'ABORTED', recovery: { txHash: HASH } });
      expect(test.broadcast).toHaveBeenCalledTimes(1);
      expect(test.wait).not.toHaveBeenCalled();
      if (kind === 'legacy')
        expect(checkpoint).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'broadcast', txHash: HASH }));
      else expect(checkpoint).toHaveBeenCalledWith(HASH);
    },
  );

  it('encodes payable writes and deployment values before raw submission', async () => {
    const test = wallet();
    await test.core.writeContract(TOKEN, ['function pay(uint256) payable'], 'pay', [7], '123');
    expect(test.populate).toHaveBeenLastCalledWith(
      expect.objectContaining({ to: TOKEN, value: 123n, data: expect.stringContaining('00000007') }),
    );
    test.wait.mockResolvedValueOnce({ hash: HASH, contractAddress: PAYTO } as never);
    expect(await test.core.deployContract(['constructor(uint256) payable'], '0x6080', [7], '456')).toEqual({
      txHash: HASH,
      contractAddress: PAYTO,
    });
    expect(test.populate).toHaveBeenLastCalledWith(
      expect.objectContaining({ value: 456n, data: expect.stringMatching(/^0x6080/) }),
    );
    expect(test.populate.mock.calls.at(-1)?.[0]).not.toHaveProperty('to');
  });

  it.each([{ code: 'UNSUPPORTED_OPERATION' }, { cause: { code: -32601 } }, { cause: { code: -32004 } }])(
    'explains unsupported raw signing safely (%j)',
    async (cause) => {
      const test = wallet();
      test.sign.mockRejectedValueOnce(cause);
      await expect(test.core.transferNative(PAYTO, '1')).rejects.toMatchObject({
        code: 'WALLET_SIGN_FAILED',
        cause,
        message: expect.stringContaining('use a local signer'),
      });
      expect(test.broadcast).not.toHaveBeenCalled();
    },
  );

  it('distinguishes rejected signing from an unsupported signer', async () => {
    const test = wallet();
    const cause = { code: 4001, message: 'private RPC content' };
    test.sign.mockRejectedValueOnce(cause);
    await expect(test.core.transferNative(PAYTO, '1')).rejects.toMatchObject({
      code: 'WALLET_SIGN_FAILED',
      cause,
      message: 'Transaction signing failed; no transaction was submitted',
    });
    expect(test.broadcast).not.toHaveBeenCalled();
  });

  it('awaits the signed-hash checkpoint before sending and does not send if that checkpoint fails', async () => {
    const test = wallet();
    const checkpoint = vi.fn(async (hash) => {
      expect(hash).toBe(keccak256('0xdeadbeef'));
      expect(test.broadcast).not.toHaveBeenCalled();
      throw new Error('journal unavailable');
    });
    await expect(test.core.broadcastErc20(TOKEN, PAYTO, '1', { onSignedTransaction: checkpoint })).rejects.toThrow(
      'journal unavailable',
    );
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(test.broadcast).not.toHaveBeenCalled();
  });
});
