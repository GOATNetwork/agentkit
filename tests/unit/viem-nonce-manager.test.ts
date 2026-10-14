import { describe, expect, it, vi } from 'vitest';
import { createWalletClient, custom, keccak256, parseAbi, parseTransaction, type Hex } from 'viem';
import { createNonceManager, privateKeyToAccount } from 'viem/accounts';
import { getTransactionCount } from 'viem/actions';
import { ViemWalletProvider } from '../../core/wallet/viem-wallet-provider';

function setup(receiptStatus = '0x1') {
  const chain = {
    id: 4217,
    name: 'test',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: ['http://localhost'] } },
  };
  // Use viem's normal JSON-RPC nonce source, including its async transport.
  const manager = createNonceManager({
    source: {
      get: ({ client, address }) => getTransactionCount(client, { address, blockTag: 'pending' }),
      set() {},
    },
  });
  const consume = vi.spyOn(manager, 'consume');
  const account = privateKeyToAccount(`0x${'11'.repeat(32)}`, { nonceManager: manager });
  const nonces: number[] = [];
  const request = vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
    switch (method) {
      case 'eth_fillTransaction':
        throw { code: -32601, message: 'unsupported' };
      case 'eth_chainId':
        return '0x1079';
      case 'eth_getTransactionCount':
        return '0x7';
      case 'eth_getBlockByNumber':
        return {
          number: '0x1',
          hash: `0x${'00'.repeat(32)}`,
          timestamp: '0x1',
          gasLimit: '0x100000',
          gasUsed: '0x0',
          transactions: [],
        };
      case 'eth_gasPrice':
        return '0x1';
      case 'eth_estimateGas':
        return '0x5208';
      case 'eth_getTransactionReceipt':
        return {
          transactionHash: params![0],
          transactionIndex: '0x0',
          blockNumber: '0x1',
          blockHash: `0x${'00'.repeat(32)}`,
          status: receiptStatus,
          gasUsed: '0x5208',
          cumulativeGasUsed: '0x5208',
          effectiveGasPrice: '0x1',
          logs: [],
          type: '0x0',
        };
      case 'eth_sendRawTransaction': {
        const raw = params![0] as Hex;
        nonces.push(parseTransaction(raw).nonce!);
        return keccak256(raw);
      }
      default:
        throw new Error(`Unexpected RPC method ${method}`);
    }
  });
  const transport = custom({ request }, { retryCount: 0 });
  const adapter = new ViemWalletProvider(account, chain, transport);
  const native = createWalletClient({ account, chain, transport });
  const send = (amount: string, signal?: AbortSignal) =>
    adapter.broadcastErc20(`0x${'22'.repeat(20)}`, `0x${'33'.repeat(20)}`, amount, { signal });
  return { send, native, nonces, consume, adapter };
}

describe('split broadcast with a real viem nonce manager', () => {
  it('rejects an actual viem reverted receipt without dropping its hash', async () => {
    const { adapter, nonces } = setup('0x0');
    await expect(adapter.transferNative(`0x${'22'.repeat(20)}`, '1')).rejects.toMatchObject({
      code: 'WALLET_TRANSFER_FAILED',
      recovery: { phase: 'broadcast', txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/) },
    });
    expect(nonces).toEqual([7]);
  });

  it('preserves managed nonces for sequential payments', async () => {
    const { send, nonces, consume } = setup();
    await send('1');
    await send('2');
    expect(nonces).toEqual([7, 8]);
    expect(consume).toHaveBeenCalledTimes(2);
  });

  it('shares reservations with concurrent native viem callers', async () => {
    const { send, native, nonces } = setup();
    await Promise.all([
      send('1'),
      native.writeContract({
        address: `0x${'22'.repeat(20)}`,
        abi: parseAbi(['function transfer(address,uint256) returns (bool)']),
        functionName: 'transfer',
        args: [`0x${'33'.repeat(20)}`, 2n],
      }),
      send('3'),
    ]);
    expect(nonces.sort()).toEqual([7, 8, 9]);
  });

  it('does not reserve a nonce for an already cancelled call', async () => {
    const { send, nonces, consume } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(send('1', controller.signal)).rejects.toMatchObject({ code: 'ABORTED' });
    expect(consume).not.toHaveBeenCalled();
    await send('2');
    expect(nonces).toEqual([7]);
  });
});
