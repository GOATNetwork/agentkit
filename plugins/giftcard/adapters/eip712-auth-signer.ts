import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import type { AuthMessage, AuthSigner, Eip712AuthDomain } from './types';

/**
 * Default EIP-712 domain for giftcard auth. Mirrors
 * gift-api/configs/config.yaml.example:56 (`chainId: 2345` is the
 * domain-separator value — NOT the wallet's connected chain).
 */
export const DEFAULT_GIFTCARD_AUTH_DOMAIN: Eip712AuthDomain = Object.freeze({
  name: 'GiftCard',
  version: '1',
  chainId: 2345,
});

/**
 * Read process.env (if available) for domain overrides at construction
 * time. We only consult env for *unspecified* fields — anything passed
 * explicitly to the constructor wins so libraries embedding the SDK can
 * lock the domain independent of process env.
 */
function resolveDomainFromEnv(explicit?: Partial<Eip712AuthDomain>): Eip712AuthDomain {
  const env = typeof process !== 'undefined' && process.env ? process.env : {};
  const name = explicit?.name ?? env.GIFTCARD_AUTH_DOMAIN_NAME ?? DEFAULT_GIFTCARD_AUTH_DOMAIN.name;
  const version =
    explicit?.version ?? env.GIFTCARD_AUTH_DOMAIN_VERSION ?? DEFAULT_GIFTCARD_AUTH_DOMAIN.version;
  const chainIdRaw =
    explicit?.chainId ?? env.GIFTCARD_AUTH_DOMAIN_CHAIN_ID ?? DEFAULT_GIFTCARD_AUTH_DOMAIN.chainId;
  const chainId = typeof chainIdRaw === 'string' ? Number.parseInt(chainIdRaw, 10) : chainIdRaw;
  if (!Number.isFinite(chainId) || chainId <= 0) {
    throw new Error(`GIFTCARD_AUTH_DOMAIN_CHAIN_ID must be a positive integer, got: ${chainIdRaw}`);
  }
  return { name, version, chainId };
}

export interface Eip712AuthSignerOptions {
  /**
   * Overrides for the EIP-712 domain. Any field omitted falls back to
   * the corresponding `GIFTCARD_AUTH_DOMAIN_*` env var, then to the
   * built-in default. Resolution happens once at construction.
   */
  domain?: Partial<Eip712AuthDomain>;
}

/**
 * AuthSigner backed by `WalletProvider.signTypedData`.
 *
 * Implementation notes:
 *   - The EIP-712 type is `Auth(address address,uint256 nonce,uint256 expiry)`
 *     (see gift-api/internal/auth/eip712.go:22). The field names are
 *     positional inside the typed-data struct; we list them in the same
 *     order so the keccak256 hash matches the backend's verifier.
 *   - `chainId` in the domain is fixed (defaults to 2345) regardless of
 *     the wallet's connected chain. This is an off-chain HMAC — the
 *     chainId is only a domain-separator value, NOT a network selector.
 *   - bigint values are passed through to `signTypedData`; viem and
 *     ethers both accept bigint for uint256 fields.
 */
export class Eip712AuthSigner implements AuthSigner {
  private readonly domain: Eip712AuthDomain;

  constructor(
    private readonly wallet: WalletProvider,
    options: Eip712AuthSignerOptions = {},
  ) {
    this.domain = resolveDomainFromEnv(options.domain);
  }

  getDomain(): Eip712AuthDomain {
    return { ...this.domain };
  }

  async getAddress(): Promise<string> {
    return this.wallet.getAddress();
  }

  async signAuth(domain: Eip712AuthDomain, message: AuthMessage): Promise<string> {
    const types: Record<string, { name: string; type: string }[]> = {
      Auth: [
        { name: 'address', type: 'address' },
        { name: 'nonce', type: 'uint256' },
        { name: 'expiry', type: 'uint256' },
      ],
    };
    const value: Record<string, unknown> = {
      address: message.address,
      nonce: typeof message.nonce === 'bigint' ? message.nonce : BigInt(message.nonce),
      expiry: typeof message.expiry === 'bigint' ? message.expiry : BigInt(message.expiry),
    };
    // Domain is parameterised so callers (e.g. tests) can override the
    // single sign call; in normal use the adapter passes
    // signer.getDomain() through.
    return this.wallet.signTypedData(
      domain as unknown as Record<string, unknown>,
      types as unknown as Record<string, unknown[]>,
      value,
    );
  }
}
