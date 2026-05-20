/**
 * Cross-cutting GNS constants and validators.
 *
 * Numeric values mirror the production mainnet deployment parameters
 * documented in `references/integration.md:128-135`:
 *   - min commitment age: 60s
 *   - max commitment age: 86400s (24h)
 *
 * The "submit buffer" of +2s applied to readiness checks is the same value
 * the production frontend uses to absorb single-block timestamp jitter.
 */

/** Minimum age (seconds) a commitment must reach before `register` accepts it. */
export const MIN_COMMITMENT_AGE_SEC = 60;

/** Maximum age (seconds) after which a commitment expires and must be re-issued. */
export const MAX_COMMITMENT_AGE_SEC = 86_400;

/**
 * Block-timestamp jitter cushion: callers should treat a commitment as ready
 * only once `blockTimestamp >= revealAt + EXPIRY_SAFETY_MARGIN_SEC`. Without
 * this margin, a tx submitted right at the boundary may land in a block
 * whose timestamp is still less than `revealAt` and revert with
 * `CommitmentTooNew`.
 *
 * 30s is generous (a typical chain reorgs <2 blocks); 2s is the canonical
 * frontend value. The waitForCommitment action uses +2s for readiness and
 * surfaces +30s as the recommended action-call safety margin.
 */
export const EXPIRY_SAFETY_MARGIN_SEC = 30;

/** Submit-buffer applied inside waitForCommitment, matching frontend convention. */
export const READINESS_SUBMIT_BUFFER_SEC = 2;

/** Seconds in one year for `years -> duration` conversions. */
export const YEAR_IN_SECONDS = 365n * 24n * 60n * 60n;

export interface GnsPaymentToken {
  symbol: string;
  address: `0x${string}`;
  decimals: number;
}

/**
 * Payment tokens the GNS registrar accepts, per network. Verified against the
 * live merchant config (`/payments/x402/config`) and the on-chain token list
 * on 2026-05-20. Testnet3 currently offers only TUSDT. Callers may always
 * override with an explicit token contract address.
 */
export const GNS_PAYMENT_TOKENS: Record<string, readonly GnsPaymentToken[]> = {
  'goat-testnet': [{ symbol: 'USDT', address: '0x030B2C744Fa080D97c0033214dEF6384f763aB21', decimals: 18 }],
  'goat-mainnet': [
    { symbol: 'USDC', address: '0x3022b87ac063DE95b1570F46f5e470F8B53112D8', decimals: 6 },
    { symbol: 'USDT', address: '0xE1AD845D93853fff44990aE0DcecD8575293681e', decimals: 6 },
  ],
};

/** Resolve a `--token` symbol (USDC/USDT, optional leading T) to a known address for the network. */
export function resolveGnsPaymentToken(network: string, symbol: string): GnsPaymentToken | undefined {
  const list = GNS_PAYMENT_TOKENS[network] ?? [];
  const norm = symbol.toUpperCase().replace(/^T(USD[CT])$/, '$1');
  return list.find((t) => t.symbol === norm);
}

/**
 * Name validation regex enforced via Zod schemas.
 *
 * Rules (mirroring `frontend/src/lib/gns/names.ts` + plan §6.1):
 *  - lowercase a-z, 0-9, and `-`
 *  - 3+ bytes per label
 *  - no leading or trailing hyphen
 *  - no dot inside the label (the `.goat` suffix is appended separately)
 */
export const LABEL_REGEX = /^(?!-)(?!.*--)[a-z0-9-]{3,}(?<!-)$/;

/**
 * Full-name regex: a valid label followed by `.goat`. Names are normalized
 * to lowercase before regex check.
 */
export const NAME_REGEX = new RegExp(`^${LABEL_REGEX.source.slice(1, -1)}\\.goat$`);

/**
 * Normalize a user-supplied name (`Alice` / `Alice.GOAT` / `alice.goat`)
 * to canonical `alice.goat`. Does NOT validate; pair with `assertValidName`
 * to enforce the label rules.
 */
export function normalizeGoatName(raw: string): { fullName: string; label: string } {
  const trimmed = raw.trim().toLowerCase();
  const fullName = trimmed.endsWith('.goat') ? trimmed : `${trimmed}.goat`;
  const label = fullName.replace(/\.goat$/, '');
  return { fullName, label };
}

/**
 * Throws if the normalized full name fails the canonical label rules.
 * Callers (Zod refines, action bodies) use this rather than re-encoding the
 * rules so the error message stays consistent.
 */
export function assertValidName(fullName: string): void {
  if (!NAME_REGEX.test(fullName)) {
    throw new Error(
      `Invalid GNS name "${fullName}": labels must be lowercase a-z/0-9/hyphens, 3+ bytes, no leading/trailing hyphen, no double hyphen, no dot inside the label`,
    );
  }
}

/**
 * Coin-type table for ENSIP-11 chain-specific address records.
 *
 * Per the ENS spec, EVM chains use `coinType = 0x80000000 | chainId`. Native
 * non-EVM chains (BTC, ETH itself, SOL) use their SLIP-44 coin types.
 *
 * Source reconciliation:
 *   - The `references/agent-usage.md` table covers ETH/BTC/SOL/BNB/GOAT
 *     mainnet/GOAT testnet/Base/Arbitrum.
 *   - `goat-ens/backend/.../contracts.defaults.ts:75-82` covers a subset
 *     (ETH/BTC/SOL/BNB/Base/Arbitrum) but DOES NOT include GOAT-mainnet
 *     or GOAT-testnet entries — those are documented in the agent-usage
 *     reference but omitted from the backend constant. We follow the
 *     agent-usage list here since it covers the agent's full address-binding
 *     surface; the backend's narrower list is for the public read API's
 *     decoded display, not for write encoding.
 */
export const COIN_TYPES = Object.freeze({
  ETH: 60,
  BTC: 0,
  SOL: 501,
  BNB: (0x80000000 | 56) >>> 0,
  BASE: (0x80000000 | 8453) >>> 0,
  ARB: (0x80000000 | 42161) >>> 0,
  GOAT_MAINNET: (0x80000000 | 2345) >>> 0,
  GOAT_TESTNET: (0x80000000 | 48816) >>> 0,
} as const);

export type CoinTypeKey = keyof typeof COIN_TYPES;

/** Sentinel referrer used by all standard register/renew paths. */
export const ZERO_REFERRER = '0x0000000000000000000000000000000000000000000000000000000000000000' as const;

/** Zero address constant. */
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
