/**
 * GNS contract registry: vendored ABI fragments and per-network addresses.
 *
 * All ABI fragments are inlined as TS string-array constants (the ethers/viem
 * "human readable" form) instead of runtime JSON imports so the build doesn't
 * need `resolveJsonModule` and the published `dist/` carries no JSON files.
 *
 * Source of truth (read-only references, not imported at runtime):
 *   - goat-ens/backend/src/modules/contracts/abis/registrar-controller.json
 *   - goat-ens/backend/src/modules/contracts/abis/public-resolver.json
 *   - goat-ens/backend/src/modules/contracts/abis/reverse-registrar.json
 *   - goat-ens/backend/src/modules/contracts/abis/ens-registry.json
 *   - goat-ens/backend/src/modules/contracts/abis/base-registrar.json
 *   - goat-ens/backend/src/modules/contracts/contracts.defaults.ts
 *
 * Subsetting policy: we vendor only the fragments the AgentKit plugin actually
 * calls (read+write). We intentionally do NOT vendor the full ABI to keep the
 * surface area small; if a future action needs additional functions, append
 * the corresponding fragment here.
 */

export type GnsNetworkKey = 'goat-mainnet' | 'goat-testnet';

export interface GnsContractRegistry {
  /** Numeric EVM chain id; 2345 = mainnet, 48816 = testnet3. */
  chainId: number;
  controller: `0x${string}`;
  publicResolver: `0x${string}`;
  ensRegistry: `0x${string}`;
  reverseRegistrar: `0x${string}`;
  baseRegistrar: `0x${string}`;
  x402Adaptor: `0x${string}`;
  /**
   * Price book contract. Not directly invoked by any action in this plugin
   * today, but bundled so callers performing custom flows (e.g. admin
   * `gns-price-book` operations from `references/integration.md:113`) can
   * reach it without duplicating the address table.
   */
  priceBook: `0x${string}`;
}

/**
 * Production contract addresses sourced from
 * goat-ens/backend/src/modules/contracts/contracts.defaults.ts (verified
 * against the live deployment artifacts referenced in
 * references/integration.md and references/agent-usage.md).
 */
export const gnsContracts: Record<GnsNetworkKey, GnsContractRegistry> = {
  'goat-testnet': {
    chainId: 48816,
    controller: '0xA95B0a09Ef70482657906a385f36AF249Fea67b6',
    publicResolver: '0x1cc3496c5B8746F9d7Dc14024110878cDdBbe264',
    ensRegistry: '0xae77570234362524d156406DD5C92E1532585400',
    reverseRegistrar: '0xB9F26b149d1D97c6176B51719F927d151E4B9DDc',
    baseRegistrar: '0x7403588D0e51C77A9601349A223Fa1dac59ADc52',
    x402Adaptor: '0xB12e68Dad886477852CC141beb3961D9C20580cA',
    priceBook: '0x612bCC20e92dab79824B3Df89e44de8A6873C7Cf',
  },
  'goat-mainnet': {
    chainId: 2345,
    controller: '0xdD3912A19eB9Aab0Cd88DdA107ec4fc2dA51D5e9',
    publicResolver: '0xD56644B440B6d0326dc777a92FB2A0d9FdB4e59D',
    ensRegistry: '0x4d652092fB4a08D186C2797e96623deaEE46aa91',
    reverseRegistrar: '0x49275954460f2f6d3F8ba537E95Db8293C7c4058',
    baseRegistrar: '0xB3Bd3075A9C12eFF3b23FAEF165D12B5C20966E0',
    x402Adaptor: '0xC0cEB3b632B0264b739BE115604D1911917d5471',
    priceBook: '0x81B36cf45Ac52F868D8948c033b9572C674ec3A4',
  },
};

export function getGnsContracts(network: GnsNetworkKey): GnsContractRegistry {
  const cfg = gnsContracts[network];
  if (!cfg) {
    throw new Error(`Unknown GNS network: ${network}`);
  }
  return cfg;
}

/**
 * GNSRegistrarController ABI fragment. Includes everything an action in this
 * plugin reads (`available`, `valid`, `rentPrice`, `commitments`,
 * `minCommitmentAge`, `maxCommitmentAge`, `makeCommitment`) and writes
 * (`commit`, `register`, `registerWithPermit`, `renew`, `renewWithPermit`).
 *
 * The `Registration` tuple field order matches
 * registrar-controller.json:53-66 and the on-chain ABI exactly. `reverseRecord`
 * is a `uint8` bitfield (per the canonical ABI), NOT a boolean — passing a
 * boolean would be coerced and the commit hash would diverge.
 */
export const REGISTRAR_CONTROLLER_ABI: readonly string[] = [
  'function available(string label) view returns (bool)',
  'function valid(string label) view returns (bool)',
  'function rentPrice(string label, address paymentToken, uint256 duration) view returns (uint256)',
  'function minCommitmentAge() view returns (uint256)',
  'function maxCommitmentAge() view returns (uint256)',
  'function commitments(bytes32 commitment) view returns (uint256)',
  'function makeCommitment(tuple(string label, address owner, uint256 duration, bytes32 secret, address resolver, bytes[] data, uint8 reverseRecord, bytes32 referrer) registration, tuple(address paymentToken, uint256 maxPaymentAmount) payment) pure returns (bytes32)',
  'function commit(bytes32 commitment)',
  'function register(tuple(string label, address owner, uint256 duration, bytes32 secret, address resolver, bytes[] data, uint8 reverseRecord, bytes32 referrer) registration, tuple(address paymentToken, uint256 maxPaymentAmount) payment)',
  'function registerWithPermit(tuple(string label, address owner, uint256 duration, bytes32 secret, address resolver, bytes[] data, uint8 reverseRecord, bytes32 referrer) registration, tuple(address paymentToken, uint256 maxPaymentAmount) payment, tuple(uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) permit)',
  'function renew(string label, tuple(address paymentToken, uint256 maxPaymentAmount) payment, uint256 duration)',
  'function renewWithPermit(string label, tuple(address paymentToken, uint256 maxPaymentAmount) payment, uint256 duration, tuple(uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) permit)',
];

/** PublicResolver ABI fragment used by setProfileRecords / setAddress. */
export const PUBLIC_RESOLVER_ABI: readonly string[] = [
  'function setText(bytes32 node, string key, string value)',
  'function setAddr(bytes32 node, address _addr)',
  'function setAddr(bytes32 node, uint256 coinType, bytes addressBytes)',
  'function multicallWithNodeCheck(bytes32 nodehash, bytes[] data) returns (bytes[] results)',
  // Read fragments for completeness (not exercised by the write actions but
  // helpful for callers performing custom verify-after-write flows).
  'function addr(bytes32 node) view returns (address)',
  'function text(bytes32 node, string key) view returns (string)',
];

/** ReverseRegistrar ABI fragment used by setPrimaryName. */
export const REVERSE_REGISTRAR_ABI: readonly string[] = [
  'function setName(string name) returns (bytes32)',
];

/** ENSRegistry ABI fragment used by ownership preflight checks. */
export const ENS_REGISTRY_ABI: readonly string[] = [
  'function owner(bytes32 node) view returns (address)',
  'function resolver(bytes32 node) view returns (address)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
];

/** BaseRegistrarImplementation ABI fragment used by `renew`/details. */
export const BASE_REGISTRAR_ABI: readonly string[] = [
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function nameExpires(uint256 id) view returns (uint256)',
];

/** ERC-20 (used for allowance preflight on `register` / `renew`). */
export const ERC20_ABI: readonly string[] = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
];

/** EIP-2612 permit-capable ERC-20 (for the *WithPermit register flows). */
export const ERC20_PERMIT_ABI: readonly string[] = [
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  'function nonces(address owner) view returns (uint256)',
];
