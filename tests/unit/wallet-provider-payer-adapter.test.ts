import { describe, expect, it } from 'vitest';
import { WalletProviderPayerAdapter } from '../../core/wallet/compat';
import type { WalletProvider } from '../../core/wallet/wallet-provider';

/**
 * Regression — Issue #3 R5 (Codex P1): `WalletProviderPayerAdapter`
 * silently bypassed the 3-way payer-binding check in
 * `goat.gns.x402.payOrder` because it didn't delegate
 * `getAddress()` / `getChainId()` to the wrapped `WalletProvider`.
 * A consumer constructing `payer = new WalletProviderPayerAdapter(walletA)`
 * with `wallet = walletB` would pass the wallet-side check (which sees
 * walletA's address) but skip the payer-side check entirely.
 *
 * The fix delegates both methods. These tests lock the delegation.
 */
class FakeWallet implements WalletProvider {
  constructor(
    private readonly addr: string,
    private readonly chainId: number,
  ) {}
  async getAddress(): Promise<string> {
    return this.addr;
  }
  async getNetwork(): Promise<string> {
    return 'fake';
  }
  async getChainId(): Promise<number> {
    return this.chainId;
  }
  async getBalance(): Promise<string> {
    return '0';
  }
  async getErc20Balance(): Promise<string> {
    return '0';
  }
  async transferNative(): Promise<{ txHash: string }> {
    return { txHash: '0xn' };
  }
  async transferErc20(): Promise<{ txHash: string }> {
    return { txHash: '0xe' };
  }
  async approveErc20(): Promise<{ txHash: string }> {
    return { txHash: '0xa' };
  }
  async signTypedData(): Promise<string> {
    return '0xs';
  }
  async callContract(): Promise<unknown> {
    return '0x';
  }
  async writeContract(): Promise<{ txHash: string }> {
    return { txHash: '0xw' };
  }
  async deployContract(): Promise<{ txHash: string; address: string }> {
    throw new Error('not used');
  }
}

class WalletWithoutChainId implements WalletProvider {
  async getAddress(): Promise<string> {
    return '0xc0ffee';
  }
  async getNetwork(): Promise<string> {
    return 'fake';
  }
  // getChainId intentionally omitted (optional on the interface)
  async getBalance(): Promise<string> {
    return '0';
  }
  async getErc20Balance(): Promise<string> {
    return '0';
  }
  async transferNative(): Promise<{ txHash: string }> {
    return { txHash: '0xn' };
  }
  async transferErc20(): Promise<{ txHash: string }> {
    return { txHash: '0xe' };
  }
  async approveErc20(): Promise<{ txHash: string }> {
    return { txHash: '0xa' };
  }
  async signTypedData(): Promise<string> {
    return '0xs';
  }
  async callContract(): Promise<unknown> {
    return '0x';
  }
  async writeContract(): Promise<{ txHash: string }> {
    return { txHash: '0xw' };
  }
  async deployContract(): Promise<{ txHash: string; address: string }> {
    throw new Error('not used');
  }
}

describe('WalletProviderPayerAdapter — Issue #3 R5 delegation', () => {
  it('getAddress() delegates to the wrapped WalletProvider so the 3-way x402 payer binding fires', async () => {
    const wallet = new FakeWallet('0x39573c7798c3d92Ec4f5e5d6A0C2f5E6B7C8d9e0', 56);
    const adapter = new WalletProviderPayerAdapter(wallet);
    await expect(adapter.getAddress()).resolves.toBe('0x39573c7798c3d92Ec4f5e5d6A0C2f5E6B7C8d9e0');
  });

  it('getChainId() delegates to the wrapped WalletProvider so the cross-chain payer chain-binding fires', async () => {
    const wallet = new FakeWallet('0x39573c7798c3d92Ec4f5e5d6A0C2f5E6B7C8d9e0', 56);
    const adapter = new WalletProviderPayerAdapter(wallet);
    await expect(adapter.getChainId()).resolves.toBe(56);
  });

  it('getChainId() throws a clear error if the wrapped wallet does not implement getChainId (rather than silently passing the binding)', async () => {
    const wallet = new WalletWithoutChainId();
    const adapter = new WalletProviderPayerAdapter(wallet);
    await expect(adapter.getChainId()).rejects.toThrow(/wrapped WalletProvider does not implement getChainId/);
  });
});
