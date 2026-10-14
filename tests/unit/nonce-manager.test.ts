import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { NonceManager, Transaction, Wallet, type Provider } from 'ethers';
import { broadcastTransaction } from '../../core/wallet/broadcast-transaction';

const commonJs = createRequire(import.meta.url)('ethers') as typeof import('ethers');

function setup(Manager = NonceManager, LocalWallet = Wallet) {
  const accepted: Transaction[] = [];
  const provider = {
    getNetwork: async () => ({ chainId: 4217n }),
    getTransactionCount: vi.fn(async () => 7),
    getFeeData: async () => ({ gasPrice: 1n, maxFeePerGas: null, maxPriorityFeePerGas: null }),
    broadcastTransaction: vi.fn(async (raw: string) => {
      const tx = Transaction.from(raw);
      accepted.push(tx);
      return { hash: tx.hash };
    }),
  };
  const signer = new Manager(new LocalWallet(`0x${'11'.repeat(32)}`, provider as unknown as Provider));
  const request = { to: `0x${'22'.repeat(20)}`, value: 1n, type: 0, chainId: 4217, gasPrice: 1n, gasLimit: 21000 };
  return { signer, request, provider, accepted };
}

describe('split broadcast with a real ethers NonceManager', () => {
  it('increments nonces for sequential payments', async () => {
    const { signer, request, accepted } = setup();
    await broadcastTransaction(signer, request);
    await broadcastTransaction(signer, { ...request, value: 2n });
    expect(accepted.map((tx) => tx.nonce)).toEqual([7, 8]);
  });

  it('reserves distinct nonces concurrently with native ethers callers', async () => {
    const { signer, request, accepted } = setup();
    await Promise.all([
      broadcastTransaction(signer, request),
      signer.sendTransaction({ ...request, value: 2n }),
      broadcastTransaction(signer, { ...request, value: 3n }),
    ]);
    expect(accepted.map((tx) => tx.nonce).sort()).toEqual([7, 8, 9]);
  });

  it('preserves reservations across the CommonJS/ESM ethers boundary', async () => {
    const { signer, request, accepted } = setup(commonJs.NonceManager, commonJs.Wallet);
    expect(signer instanceof NonceManager).toBe(false);
    await broadcastTransaction(signer, request);
    await Promise.all([
      broadcastTransaction(signer, { ...request, value: 2n }),
      signer.sendTransaction({ ...request, value: 3n }),
    ]);
    expect(accepted.map((tx) => tx.nonce).sort()).toEqual([7, 8, 9]);
  });

  it('does not reserve a nonce when already cancelled', async () => {
    const { signer, request, accepted } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(broadcastTransaction(signer, request, controller.signal)).rejects.toMatchObject({ code: 'ABORTED' });
    await broadcastTransaction(signer, request);
    expect(accepted.map((tx) => tx.nonce)).toEqual([7]);
  });

  it('does not send after cancelled preflight, and preserves ethers reservation/reset semantics', async () => {
    const { signer, request, accepted } = setup();
    const controller = new AbortController();
    const populate = signer.populateTransaction.bind(signer);
    vi.spyOn(signer, 'populateTransaction').mockImplementationOnce(async (tx) => {
      const populated = await populate(tx);
      controller.abort();
      return populated;
    });
    await expect(broadcastTransaction(signer, request, controller.signal)).rejects.toMatchObject({ code: 'ABORTED' });
    expect(accepted).toHaveLength(0);
    expect(await signer.getNonce('pending')).toBe(8);
    // The operator has reconciled this single reservation: no other call was
    // concurrent and no RPC was submitted. Reset can now recover the unused nonce.
    signer.reset();
    await broadcastTransaction(signer, request);
    expect(accepted.map((tx) => tx.nonce)).toEqual([7]);
  });
});
