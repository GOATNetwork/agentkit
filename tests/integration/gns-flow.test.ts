import { describe, expect, it } from 'vitest';
import { ActionProvider } from '../../providers/action-provider';
import { PolicyEngine } from '../../core/policy/policy-engine';
import { ExecutionRuntime } from '../../core/runtime/execution-runtime';
import { commitAction } from '../../plugins/gns/actions/commit';
import { registerAction } from '../../plugins/gns/actions/register';
import { waitForCommitmentAction } from '../../plugins/gns/actions/wait-for-commitment';
import { getGnsContracts } from '../../plugins/gns/adapters/contracts';
import type { WalletProvider } from '../../core/wallet/wallet-provider';

const contracts = getGnsContracts('goat-testnet');

interface FakeWalletState {
  address: string;
  chainId: number;
  blockTimestamp: number;
  /** commit hash -> submittedAt seconds (0 = absent). */
  commitments: Map<string, number>;
  /** allowance returned to register's allowance() read. */
  allowance: bigint;
  derivedCommitHash: `0x${string}`;
  writeCount: number;
}

function makeFakeWallet(state: Partial<FakeWalletState> = {}): WalletProvider & {
  _state: FakeWalletState;
  getLatestBlockTimestamp(): Promise<number>;
} {
  const s: FakeWalletState = {
    address: '0x39573c7798c3d92Ec4f5e5d6A0C2f5E6B7C8d9e0',
    chainId: 48816,
    blockTimestamp: 1_700_000_000,
    commitments: new Map(),
    allowance: BigInt('999999999999999999999999999'),
    derivedCommitHash: '0x' + 'cc'.repeat(32) as `0x${string}`,
    writeCount: 0,
    ...state,
  };
  return {
    _state: s,
    async getAddress() {
      return s.address;
    },
    async getNetwork() {
      return 'goat-testnet';
    },
    async getChainId() {
      return s.chainId;
    },
    async getBalance() {
      return '0';
    },
    async getErc20Balance() {
      return '0';
    },
    async transferNative() {
      return { txHash: '0xmock_native' };
    },
    async transferErc20() {
      return { txHash: '0xmock_erc20' };
    },
    async approveErc20() {
      return { txHash: '0xmock_approve' };
    },
    async signTypedData() {
      return '0xmock_typed_data';
    },
    async getLatestBlockTimestamp() {
      return s.blockTimestamp;
    },
    async callContract(_addr, _abi, fn, args) {
      if (fn === 'makeCommitment') return s.derivedCommitHash;
      if (fn === 'commitments') {
        const h = String(args[0]);
        return BigInt(s.commitments.get(h) ?? 0);
      }
      if (fn === 'allowance') return s.allowance;
      if (fn === 'owner') return s.address;
      if (fn === 'ownerOf') return s.address;
      if (fn === 'isApprovedForAll') return true;
      return '0x';
    },
    async writeContract(_addr, _abi, fn) {
      s.writeCount += 1;
      if (fn === 'commit') {
        // Record submittedAt on the fly so the chained register call sees a commit.
        s.commitments.set(s.derivedCommitHash, s.blockTimestamp);
      }
      return { txHash: `0xmock_${fn}_${s.writeCount}` };
    },
    async deployContract() {
      throw new Error('not used');
    },
  };
}

function buildRuntime(wallet: WalletProvider) {
  const provider = new ActionProvider();
  provider.register(commitAction(contracts, wallet));
  provider.register(waitForCommitmentAction(contracts, wallet));
  provider.register(registerAction(contracts, wallet));
  const policy = new PolicyEngine({
    allowedNetworks: ['goat-testnet'],
    maxRiskWithoutConfirm: 'low',
    writeEnabled: true,
  });
  const runtime = new ExecutionRuntime(policy, { maxRetries: 0, retryDelayMs: 10 });
  const context = { traceId: 'trace_gns_flow', network: 'goat-testnet', now: Date.now() };
  return { provider, runtime, context };
}

const COMMIT_INPUT = {
  name: 'alice',
  owner: '0x39573c7798c3d92Ec4f5e5d6A0C2f5E6B7C8d9e0' as const,
  years: 1,
  paymentTokenAddress: '0xFCA5846c86dC8Df1B1e21447649A08a18B667B92' as const,
  paymentTokenSymbol: 'USDC',
  amountWei: '3000000000000000000',
  resolverData: [] as string[],
  reverseRecord: 0 as const,
  referrer: '0x' + '00'.repeat(32),
};

describe('gns flow: commit → waitForCommitment → register', () => {
  it('happy path: commit, wait until ready, register succeeds', async () => {
    const wallet = makeFakeWallet();
    const { provider, runtime, context } = buildRuntime(wallet);

    const commitRes = await runtime.run(provider.get('goat.gns.commit'), context, COMMIT_INPUT, {
      confirmed: true,
    });
    expect(commitRes.ok).toBe(true);
    const commit = commitRes.output!;
    const commitHash = commit.commitment;

    // Fast-forward block.timestamp past the reveal window + 2s buffer.
    wallet._state.blockTimestamp += 65;

    const waitRes = await runtime.run(provider.get('goat.gns.waitForCommitment'), context, {
      commitment: commitHash,
    });
    expect(waitRes.ok).toBe(true);
    expect(waitRes.output!.isReady).toBe(true);
    expect(waitRes.output!.isExpired).toBe(false);

    const registerRes = await runtime.run(provider.get('goat.gns.register'), context, {
      name: commit.registration.label + '.goat',
      commitHash,
      paymentTokenAddress: commit.paymentToken.address,
      paymentTokenSymbol: commit.paymentToken.symbol,
      amountWei: commit.amountWei,
      duration: commit.registration.duration,
      years: commit.years,
      secret: commit.secret,
      owner: commit.registration.owner,
      resolverData: commit.registration.data,
      reverseRecord: commit.registration.reverseRecord,
      referrer: commit.registration.referrer,
    }, { confirmed: true });
    expect(registerRes.ok).toBe(true);
    expect(registerRes.output!.used).toBe('register');
  });

  it('too-early branch: waitForCommitment reports isReady=false and register rejects', async () => {
    const wallet = makeFakeWallet();
    const { provider, runtime, context } = buildRuntime(wallet);
    const commitRes = await runtime.run(provider.get('goat.gns.commit'), context, COMMIT_INPUT, {
      confirmed: true,
    });
    expect(commitRes.ok).toBe(true);
    const commit = commitRes.output!;

    // Block clock hasn't advanced — commit is "too new".
    const waitRes = await runtime.run(provider.get('goat.gns.waitForCommitment'), context, {
      commitment: commit.commitment,
    });
    expect(waitRes.ok).toBe(true);
    expect(waitRes.output!.isReady).toBe(false);
    expect(waitRes.output!.isExpired).toBe(false);

    const registerRes = await runtime.run(provider.get('goat.gns.register'), context, {
      name: commit.registration.label + '.goat',
      commitHash: commit.commitment,
      paymentTokenAddress: commit.paymentToken.address,
      paymentTokenSymbol: commit.paymentToken.symbol,
      amountWei: commit.amountWei,
      duration: commit.registration.duration,
      years: commit.years,
      secret: commit.secret,
      owner: commit.registration.owner,
      resolverData: commit.registration.data,
      reverseRecord: commit.registration.reverseRecord,
      referrer: commit.registration.referrer,
    }, { confirmed: true });
    expect(registerRes.ok).toBe(false);
    expect(registerRes.errorCode).toBe('INVALID_INPUT');
  });

  it('expired branch: waitForCommitment reports isExpired=true and register rejects', async () => {
    const wallet = makeFakeWallet();
    const { provider, runtime, context } = buildRuntime(wallet);
    const commitRes = await runtime.run(provider.get('goat.gns.commit'), context, COMMIT_INPUT, {
      confirmed: true,
    });
    expect(commitRes.ok).toBe(true);
    const commit = commitRes.output!;

    // Push past maxCommitmentAge.
    wallet._state.blockTimestamp += 86_400 + 10;

    const waitRes = await runtime.run(provider.get('goat.gns.waitForCommitment'), context, {
      commitment: commit.commitment,
    });
    expect(waitRes.ok).toBe(true);
    expect(waitRes.output!.isExpired).toBe(true);

    const registerRes = await runtime.run(provider.get('goat.gns.register'), context, {
      name: commit.registration.label + '.goat',
      commitHash: commit.commitment,
      paymentTokenAddress: commit.paymentToken.address,
      paymentTokenSymbol: commit.paymentToken.symbol,
      amountWei: commit.amountWei,
      duration: commit.registration.duration,
      years: commit.years,
      secret: commit.secret,
      owner: commit.registration.owner,
      resolverData: commit.registration.data,
      reverseRecord: commit.registration.reverseRecord,
      referrer: commit.registration.referrer,
    }, { confirmed: true });
    expect(registerRes.ok).toBe(false);
    expect(registerRes.errorCode).toBe('INVALID_INPUT');
  });

  it('binding-mismatch branch: register rejects when commitHash diverges from re-derived hash', async () => {
    const wallet = makeFakeWallet();
    const { provider, runtime, context } = buildRuntime(wallet);
    const commitRes = await runtime.run(provider.get('goat.gns.commit'), context, COMMIT_INPUT, {
      confirmed: true,
    });
    expect(commitRes.ok).toBe(true);
    const commit = commitRes.output!;
    wallet._state.blockTimestamp += 65;

    const registerRes = await runtime.run(provider.get('goat.gns.register'), context, {
      name: commit.registration.label + '.goat',
      // Mutate the commit hash so the on-chain re-derive disagrees.
      commitHash: '0xbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbad0',
      paymentTokenAddress: commit.paymentToken.address,
      paymentTokenSymbol: commit.paymentToken.symbol,
      amountWei: commit.amountWei,
      duration: commit.registration.duration,
      years: commit.years,
      secret: commit.secret,
      owner: commit.registration.owner,
      resolverData: commit.registration.data,
      reverseRecord: commit.registration.reverseRecord,
      referrer: commit.registration.referrer,
    }, { confirmed: true });
    expect(registerRes.ok).toBe(false);
    expect(registerRes.errorCode).toBe('INVALID_INPUT');
  });
});
