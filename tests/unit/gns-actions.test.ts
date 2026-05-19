import { describe, expect, it } from 'vitest';
import {
  COIN_TYPES,
  LABEL_REGEX,
  NAME_REGEX,
  assertValidName,
  normalizeGoatName,
} from '../../plugins/gns/constants';
import { checkAvailabilityAction } from '../../plugins/gns/actions/check-availability';
import { commitAction } from '../../plugins/gns/actions/commit';
import { registerAction } from '../../plugins/gns/actions/register';
import { renewAction } from '../../plugins/gns/actions/renew';
import { setPrimaryNameAction } from '../../plugins/gns/actions/set-primary-name';
import { setProfileRecordsAction } from '../../plugins/gns/actions/set-profile-records';
import { setAddressAction } from '../../plugins/gns/actions/set-address';
import { waitForCommitmentAction } from '../../plugins/gns/actions/wait-for-commitment';
import { x402CreateOrderAction } from '../../plugins/gns/actions/x402-create-order';
import { x402SubmitSignatureAction } from '../../plugins/gns/actions/x402-submit-signature';
import { x402PayOrderAction } from '../../plugins/gns/actions/x402-pay-order';
import { x402GetOrderStatusAction } from '../../plugins/gns/actions/x402-get-order-status';
import { estimatePriceAction } from '../../plugins/gns/actions/estimate-price';
import { getNameDetailsAction } from '../../plugins/gns/actions/get-name-details';
import { getMyNamesAction } from '../../plugins/gns/actions/get-my-names';
import { getGnsContracts } from '../../plugins/gns/adapters/contracts';
import type { GnsApiAdapter, SearchResponse } from '../../plugins/gns/adapters/types';
import type { WalletProvider } from '../../core/wallet/wallet-provider';
import type { PayerWalletAdapter } from '../../plugins/x402/adapters/types';

// ─────────────────────────────────────────────────────────────────────────────
// Typed mocks (no `any`).
// ─────────────────────────────────────────────────────────────────────────────

const NOT_USED = (name: string) => () => {
  throw new Error(`StubApi.${name} not used in this test`);
};

class StubApi implements GnsApiAdapter {
  searchResults: SearchResponse['results'] = [{ name: 'alice.goat', status: 'available' }];
  async search(): Promise<SearchResponse> {
    return { query: 'alice', normalizedQuery: 'alice.goat', results: this.searchResults };
  }
  details = NOT_USED('details') as GnsApiAdapter['details'];
  async quote() {
    return {
      name: 'alice.goat',
      years: 1,
      durationSeconds: '31536000',
      currency: 'tUSDC',
      decimals: 18,
      registrationFee: '3.0',
      estimatedGas: '0.0000',
      total: '3.0',
      totalWei: '3000000000000000000',
    };
  }
  async myNames() {
    return { address: '0x0000000000000000000000000000000000000001' as `0x${string}`, total: 0, items: [] };
  }
  x402Config = NOT_USED('x402Config') as GnsApiAdapter['x402Config'];
  createX402Order = NOT_USED('createX402Order') as GnsApiAdapter['createX402Order'];
  async getX402Order() {
    return { orderId: 'o1', status: 'CHECKOUT_VERIFIED' as const, raw: {} };
  }
  async submitX402Signature() {
    return { status: 'authorized' as const };
  }
}

interface MockWalletState {
  address: string;
  chainId: number;
  blockTimestamp: number;
  commitments: Map<string, number>;
  callContractImpl?: (addr: string, fn: string, args: readonly unknown[]) => unknown;
}

function makeWallet(state: Partial<MockWalletState> = {}): WalletProvider & { _state: MockWalletState } {
  const s: MockWalletState = {
    address: '0x39573c7798c3d92Ec4f5e5d6A0C2f5E6B7C8d9e0',
    chainId: 48816,
    blockTimestamp: 0,
    commitments: new Map(),
    ...state,
  };
  const wallet: WalletProvider & { _state: MockWalletState; getLatestBlockTimestamp(): Promise<number> } = {
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
    async callContract(addr, _abi, fn, args) {
      if (s.callContractImpl) return s.callContractImpl(addr, fn, args);
      if (fn === 'makeCommitment')
        return '0x1111111111111111111111111111111111111111111111111111111111111111';
      if (fn === 'commitments') {
        const h = String(args[0]);
        return BigInt(s.commitments.get(h) ?? 0);
      }
      if (fn === 'allowance') return BigInt('999999999999999999999999');
      if (fn === 'owner') return s.address; // ENS registry owner == caller
      if (fn === 'ownerOf') return s.address; // baseRegistrar owner == caller
      if (fn === 'isApprovedForAll') return true;
      return '0x';
    },
    async writeContract() {
      return { txHash: '0xmock_write' };
    },
    async deployContract() {
      throw new Error('not used');
    },
  };
  return wallet;
}

const contracts = getGnsContracts('goat-testnet');

// ─────────────────────────────────────────────────────────────────────────────
// Constants / helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('plugins/gns constants', () => {
  it('normalizes Alice.GOAT to alice.goat', () => {
    expect(normalizeGoatName('Alice.GOAT')).toEqual({ fullName: 'alice.goat', label: 'alice' });
    expect(normalizeGoatName('  Bob  ')).toEqual({ fullName: 'bob.goat', label: 'bob' });
    expect(normalizeGoatName('zoe.goat')).toEqual({ fullName: 'zoe.goat', label: 'zoe' });
  });

  it('LABEL_REGEX rejects bad labels', () => {
    expect(LABEL_REGEX.test('alice')).toBe(true);
    expect(LABEL_REGEX.test('a1b')).toBe(true);
    expect(LABEL_REGEX.test('ab')).toBe(false); // <3 chars
    expect(LABEL_REGEX.test('-abc')).toBe(false); // leading hyphen
    expect(LABEL_REGEX.test('abc-')).toBe(false); // trailing hyphen
    expect(LABEL_REGEX.test('AB-C')).toBe(false); // uppercase
    expect(LABEL_REGEX.test('a.b')).toBe(false); // dot inside
  });

  it('NAME_REGEX matches normalized names only', () => {
    expect(NAME_REGEX.test('alice.goat')).toBe(true);
    expect(NAME_REGEX.test('Alice.GOAT')).toBe(false);
    expect(NAME_REGEX.test('alice')).toBe(false);
    expect(() => assertValidName('alice.goat')).not.toThrow();
    expect(() => assertValidName('-alice.goat')).toThrow();
  });

  it('COIN_TYPES table includes GOAT mainnet/testnet entries (delta vs backend contracts.defaults.ts)', () => {
    expect(COIN_TYPES.ETH).toBe(60);
    expect(COIN_TYPES.BTC).toBe(0);
    expect(COIN_TYPES.SOL).toBe(501);
    expect(COIN_TYPES.BASE).toBe((0x80000000 | 8453) >>> 0);
    expect(COIN_TYPES.GOAT_MAINNET).toBe((0x80000000 | 2345) >>> 0);
    expect(COIN_TYPES.GOAT_TESTNET).toBe((0x80000000 | 48816) >>> 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Action shape contracts
// ─────────────────────────────────────────────────────────────────────────────

describe('plugins/gns action shape contracts', () => {
  const api = new StubApi();
  const wallet = makeWallet();
  const payer: PayerWalletAdapter = {
    async normalizeAuthorization(s) {
      return s;
    },
    async signCalldataTypedData() {
      return '0xmocksig';
    },
    async transferToken() {
      return { txHash: '0xmock_transfer' };
    },
  };

  it('all action factories build action definitions with the expected names', () => {
    const defs = [
      checkAvailabilityAction(api),
      getNameDetailsAction(api),
      getMyNamesAction(api),
      estimatePriceAction(api),
      commitAction(contracts, wallet),
      waitForCommitmentAction(contracts, wallet),
      registerAction(contracts, wallet),
      renewAction(contracts, wallet),
      setProfileRecordsAction(contracts, wallet),
      setAddressAction(contracts, wallet),
      setPrimaryNameAction(contracts, wallet),
      x402CreateOrderAction(api),
      x402SubmitSignatureAction(api, payer),
      x402PayOrderAction(api, payer, wallet),
      x402GetOrderStatusAction(api),
    ];
    expect(defs.map((d) => d.name)).toEqual([
      'goat.gns.checkAvailability',
      'goat.gns.getNameDetails',
      'goat.gns.getMyNames',
      'goat.gns.estimatePrice',
      'goat.gns.commit',
      'goat.gns.waitForCommitment',
      'goat.gns.register',
      'goat.gns.renew',
      'goat.gns.setProfileRecords',
      'goat.gns.setAddress',
      'goat.gns.setPrimaryName',
      'goat.gns.x402.createOrder',
      'goat.gns.x402.submitSignature',
      'goat.gns.x402.payOrder',
      'goat.gns.x402.getOrderStatus',
    ]);
  });

  it('risk levels match the spec', () => {
    const expected: Record<string, 'read' | 'low' | 'medium' | 'high'> = {
      'goat.gns.checkAvailability': 'read',
      'goat.gns.getNameDetails': 'read',
      'goat.gns.getMyNames': 'read',
      'goat.gns.estimatePrice': 'read',
      'goat.gns.commit': 'medium',
      'goat.gns.waitForCommitment': 'read',
      'goat.gns.register': 'high',
      'goat.gns.renew': 'high',
      'goat.gns.setProfileRecords': 'medium',
      'goat.gns.setAddress': 'medium',
      'goat.gns.setPrimaryName': 'medium',
      'goat.gns.x402.createOrder': 'medium',
      'goat.gns.x402.submitSignature': 'high',
      'goat.gns.x402.payOrder': 'high',
      'goat.gns.x402.getOrderStatus': 'read',
    };
    const defs = [
      checkAvailabilityAction(api),
      getNameDetailsAction(api),
      getMyNamesAction(api),
      estimatePriceAction(api),
      commitAction(contracts, wallet),
      waitForCommitmentAction(contracts, wallet),
      registerAction(contracts, wallet),
      renewAction(contracts, wallet),
      setProfileRecordsAction(contracts, wallet),
      setAddressAction(contracts, wallet),
      setPrimaryNameAction(contracts, wallet),
      x402CreateOrderAction(api),
      x402SubmitSignatureAction(api, payer),
      x402PayOrderAction(api, payer, wallet),
      x402GetOrderStatusAction(api),
    ];
    for (const d of defs) expect(d.riskLevel).toBe(expected[d.name]);
  });

  it('networks arrays match the spec (GOAT writes/reads vs x402 wildcards)', () => {
    const goatPair = ['goat-mainnet', 'goat-testnet'];
    const cases: Array<[string, string[]]> = [
      ['goat.gns.checkAvailability', goatPair],
      ['goat.gns.getNameDetails', goatPair],
      ['goat.gns.getMyNames', goatPair],
      ['goat.gns.estimatePrice', goatPair],
      ['goat.gns.commit', goatPair],
      ['goat.gns.waitForCommitment', goatPair],
      ['goat.gns.register', goatPair],
      ['goat.gns.renew', goatPair],
      ['goat.gns.setProfileRecords', goatPair],
      ['goat.gns.setAddress', goatPair],
      ['goat.gns.setPrimaryName', goatPair],
      ['goat.gns.x402.createOrder', []],
      ['goat.gns.x402.submitSignature', []],
      ['goat.gns.x402.payOrder', []],
      ['goat.gns.x402.getOrderStatus', []],
    ];
    const defs = [
      checkAvailabilityAction(api),
      getNameDetailsAction(api),
      getMyNamesAction(api),
      estimatePriceAction(api),
      commitAction(contracts, wallet),
      waitForCommitmentAction(contracts, wallet),
      registerAction(contracts, wallet),
      renewAction(contracts, wallet),
      setProfileRecordsAction(contracts, wallet),
      setAddressAction(contracts, wallet),
      setPrimaryNameAction(contracts, wallet),
      x402CreateOrderAction(api),
      x402SubmitSignatureAction(api, payer),
      x402PayOrderAction(api, payer, wallet),
      x402GetOrderStatusAction(api),
    ];
    const byName = new Map(defs.map((d) => [d.name, d.networks]));
    for (const [name, expected] of cases) expect(byName.get(name)).toEqual(expected);
  });

  it("commit declares 'secret' in sensitiveOutputFields", () => {
    const def = commitAction(contracts, wallet);
    expect(def.sensitiveOutputFields).toContain('secret');
  });

  it("register declares 'secret' in sensitiveInputFields", () => {
    const def = registerAction(contracts, wallet);
    expect(def.sensitiveInputFields).toContain('secret');
  });

  it('every action exposes a zodOutputSchema', () => {
    const defs = [
      checkAvailabilityAction(api),
      getNameDetailsAction(api),
      getMyNamesAction(api),
      estimatePriceAction(api),
      commitAction(contracts, wallet),
      waitForCommitmentAction(contracts, wallet),
      registerAction(contracts, wallet),
      renewAction(contracts, wallet),
      setProfileRecordsAction(contracts, wallet),
      setAddressAction(contracts, wallet),
      setPrimaryNameAction(contracts, wallet),
      x402CreateOrderAction(api),
      x402SubmitSignatureAction(api, payer),
      x402PayOrderAction(api, payer, wallet),
      x402GetOrderStatusAction(api),
    ];
    for (const d of defs) expect(d.zodOutputSchema).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Input-schema edges that the plan explicitly calls out
// ─────────────────────────────────────────────────────────────────────────────

describe('plugins/gns input schema edges', () => {
  const api = new StubApi();
  const wallet = makeWallet();
  const commit = commitAction(contracts, wallet);

  it('reverseRecord accepts only 0 or 1 (uint8, NOT boolean)', () => {
    const baseInput = {
      name: 'alice',
      owner: '0x39573c7798c3d92Ec4f5e5d6A0C2f5E6B7C8d9e0' as const,
      years: 1,
      paymentTokenAddress: '0xFCA5846c86dC8Df1B1e21447649A08a18B667B92' as const,
      paymentTokenSymbol: 'USDC',
      amountWei: '3000000000000000000',
    };
    expect(commit.zodInputSchema?.safeParse({ ...baseInput, reverseRecord: 0 }).success).toBe(true);
    expect(commit.zodInputSchema?.safeParse({ ...baseInput, reverseRecord: 1 }).success).toBe(true);
    expect(commit.zodInputSchema?.safeParse({ ...baseInput, reverseRecord: 2 }).success).toBe(false);
    expect(commit.zodInputSchema?.safeParse({ ...baseInput, reverseRecord: true }).success).toBe(false);
  });

  it('estimate-price rejects out-of-range years', () => {
    const def = estimatePriceAction(api);
    expect(def.zodInputSchema?.safeParse({ name: 'alice', years: 0 }).success).toBe(false);
    expect(def.zodInputSchema?.safeParse({ name: 'alice', years: 11 }).success).toBe(false);
    expect(def.zodInputSchema?.safeParse({ name: 'alice', years: 5 }).success).toBe(true);
  });

  it('checkAvailability normalizes Alice.GOAT through the action execute', async () => {
    const def = checkAvailabilityAction(api);
    const out = await def.execute(
      { traceId: 't', network: 'goat-testnet', now: Date.now() },
      { name: 'Alice.GOAT' },
    );
    expect(out.normalized).toBe('alice.goat');
    expect(out.available).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Commitment-hash determinism (a property of the on-chain pure makeCommitment)
// ─────────────────────────────────────────────────────────────────────────────

describe('plugins/gns commit determinism', () => {
  it('the commit action delegates the hash to controller.makeCommitment and returns the same bytes32', async () => {
    const api = new StubApi();
    void api; // not used in this commit-only path
    const wallet = makeWallet();
    const def = commitAction(contracts, wallet);
    const out1 = await def.execute(
      { traceId: 't1', network: 'goat-testnet', now: Date.now() },
      {
        name: 'alice',
        owner: '0x39573c7798c3d92Ec4f5e5d6A0C2f5E6B7C8d9e0',
        years: 1,
        paymentTokenAddress: '0xFCA5846c86dC8Df1B1e21447649A08a18B667B92',
        paymentTokenSymbol: 'USDC',
        amountWei: '3000000000000000000',
        resolverData: [],
        reverseRecord: 0,
        referrer: '0x0000000000000000000000000000000000000000000000000000000000000000',
      },
    );
    expect(out1.commitment).toBe('0x1111111111111111111111111111111111111111111111111111111111111111');
    // sensitiveOutputFields is on the definition; the raw secret is still on the output for chaining.
    expect(out1.secret).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
