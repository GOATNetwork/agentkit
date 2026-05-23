import { describe, expect, it } from 'vitest';
import { registerAction } from '../../plugins/gns/actions/register';
import { getGnsContracts } from '../../plugins/gns/adapters/contracts';
import { YEAR_IN_SECONDS } from '../../plugins/gns/constants';
import { AgentkitRuntimeError } from '../../core/errors/error';
import { ErrorCodes } from '../../core/errors/error-codes';
import type { WalletProvider } from '../../core/wallet/wallet-provider';

const contracts = getGnsContracts('goat-testnet');

const BOUND_COMMIT_HASH = '0xdeadbeef00000000000000000000000000000000000000000000000000000000';
const DERIVED_HASH = '0x1111111111111111111111111111111111111111111111111111111111111111';
const OWNER = '0x39573c7798c3d92Ec4f5e5d6A0C2f5E6B7C8d9e0';
const SECRET = '0x' + '11'.repeat(32);
const TOKEN = '0xFCA5846c86dC8Df1B1e21447649A08a18B667B92';

function makeWallet(): WalletProvider & { getLatestBlockTimestamp(): Promise<number>; writeCalled: number } {
  const w = {
    writeCalled: 0,
    async getAddress() {
      return OWNER;
    },
    async getNetwork() {
      return 'goat-testnet';
    },
    async getChainId() {
      return 48816;
    },
    async getBalance() {
      return '0';
    },
    async getErc20Balance() {
      return '0';
    },
    async transferNative() {
      return { txHash: '0xnope' };
    },
    async transferErc20() {
      return { txHash: '0xnope' };
    },
    async approveErc20() {
      return { txHash: '0xnope' };
    },
    async signTypedData() {
      return '0xnope';
    },
    async getLatestBlockTimestamp() {
      return 1_700_000_000 + 120;
    },
    async callContract(_addr: string, _abi: string[], fn: string) {
      if (fn === 'makeCommitment') return DERIVED_HASH;
      if (fn === 'commitments') return BigInt(1_700_000_000);
      if (fn === 'allowance') return BigInt('999999999999999999999999999');
      return '0x';
    },
    async writeContract() {
      w.writeCalled++;
      return { txHash: '0xshould-not-be-called' };
    },
    async deployContract() {
      throw new Error('not used');
    },
  };
  return w;
}

describe('register binding enforcement', () => {
  const def = registerAction(contracts, makeWallet());
  const baseInput = {
    name: 'alice.goat',
    commitHash: BOUND_COMMIT_HASH, // intentionally NOT equal to derived hash
    paymentTokenAddress: TOKEN,
    paymentTokenSymbol: 'USDC',
    amountWei: '3000000000000000000',
    duration: (BigInt(1) * YEAR_IN_SECONDS).toString(),
    years: 1,
    secret: SECRET,
    owner: OWNER,
    resolverData: [],
    reverseRecord: 0 as 0 | 1,
    referrer: '0x' + '00'.repeat(32),
  };

  it('rejects mismatched commitHash with INVALID_INPUT before any write', async () => {
    const wallet = makeWallet();
    const action = registerAction(contracts, wallet);
    await expect(
      action.execute({ traceId: 't', network: 'goat-testnet', now: Date.now() }, baseInput),
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_INPUT });
    expect(wallet.writeCalled).toBe(0);
  });

  it('rejects duration/years mismatch up-front', async () => {
    const wallet = makeWallet();
    const action = registerAction(contracts, wallet);
    const bad = { ...baseInput, duration: '0', years: 1 };
    await expect(
      action.execute({ traceId: 't', network: 'goat-testnet', now: Date.now() }, bad),
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_INPUT });
    expect(wallet.writeCalled).toBe(0);
  });

  it('accepts when commit hash matches and submits register', async () => {
    const wallet = makeWallet();
    const action = registerAction(contracts, wallet);
    const ok = { ...baseInput, commitHash: DERIVED_HASH };
    const out = await action.execute({ traceId: 't', network: 'goat-testnet', now: Date.now() }, ok);
    expect(out.used).toBe('register');
    expect(wallet.writeCalled).toBe(1);
  });

  // Belt-and-suspenders: the structural input check is independent of execute().
  it('Zod input schema fails on missing secret', () => {
    const r = def.zodInputSchema?.safeParse({ ...baseInput, secret: 'not-hex' });
    expect(r?.success).toBe(false);
  });

  it('throws AgentkitRuntimeError (not a generic Error)', async () => {
    const wallet = makeWallet();
    const action = registerAction(contracts, wallet);
    try {
      await action.execute({ traceId: 't', network: 'goat-testnet', now: Date.now() }, baseInput);
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AgentkitRuntimeError);
    }
  });
});
