/**
 * Wallet construction helpers for the CLI binaries.
 *
 * Two factories:
 *
 *   - `createEvmWalletProvider({ rpcUrl, privateKey, networkName })`
 *     Builds an `EvmWalletProvider` (ethers) from a JSON-RPC URL and a
 *     0x-prefixed private key. Throws on missing inputs.
 *
 *   - `createWalletPair()`
 *     Returns `{ authWallet, paymentWallet }` derived from environment.
 *     `authWallet` connects to GOAT (testnet by default — switches to
 *     mainnet if `GOAT_NETWORK=goat-mainnet`). `paymentWallet` connects
 *     to whichever EVM chain the user is paying from (Base, etc.) via
 *     `PAYMENT_CHAIN_RPC_URL` + `PAYMENT_CHAIN_PRIVATE_KEY` +
 *     `PAYMENT_CHAIN_ID`. If `PAYMENT_CHAIN_*` is missing, paymentWallet
 *     falls back to the auth wallet (useful for GOAT-native flows).
 *
 * Both helpers refuse to start without their private key unless
 * `process.env.DEMO_MOCK === 'true'`, in which case a `NoopWalletProvider`
 * is returned so callers can dry-run shape inspection.
 */
import { JsonRpcProvider, Wallet } from 'ethers';
import { EvmWalletProvider } from '../../core/wallet/evm-wallet-provider';
import { NoopWalletProvider } from '../../core/wallet/noop-wallet-provider';
import { goatNetworks } from '../../networks/goat/config';

export interface CreateEvmWalletOptions {
  rpcUrl: string;
  privateKey: string;
  networkName: string;
}

export function createEvmWalletProvider(opts: CreateEvmWalletOptions): EvmWalletProvider {
  if (!opts.rpcUrl) throw new Error('createEvmWalletProvider: rpcUrl is required');
  if (!opts.privateKey) throw new Error('createEvmWalletProvider: privateKey is required');
  if (!opts.networkName) throw new Error('createEvmWalletProvider: networkName is required');
  const provider = new JsonRpcProvider(opts.rpcUrl);
  const signer = new Wallet(opts.privateKey, provider);
  return new EvmWalletProvider(signer, provider, opts.networkName);
}

export interface WalletPair {
  authWallet: EvmWalletProvider | NoopWalletProvider;
  paymentWallet: EvmWalletProvider | NoopWalletProvider;
}

export interface CreateWalletPairOptions {
  /** When true and no private key is present, return Noop wallets instead of throwing. */
  allowMock?: boolean;
  /** Override the auth network (defaults to env `GOAT_NETWORK` or 'goat-testnet'). */
  network?: 'goat-mainnet' | 'goat-testnet';
}

function isDemoMock(): boolean {
  return process.env.DEMO_MOCK === 'true';
}

export function createWalletPair(opts: CreateWalletPairOptions = {}): WalletPair {
  const networkKey: 'goat-mainnet' | 'goat-testnet' =
    opts.network ?? ((process.env.GOAT_NETWORK as 'goat-mainnet' | 'goat-testnet' | undefined) ?? 'goat-testnet');
  const cfg = goatNetworks[networkKey];

  const goatPrivateKey = process.env.GOAT_PRIVATE_KEY;
  const paymentPrivateKey = process.env.PAYMENT_CHAIN_PRIVATE_KEY ?? goatPrivateKey;
  const paymentRpc = process.env.PAYMENT_CHAIN_RPC_URL;
  const paymentChainId = process.env.PAYMENT_CHAIN_ID ? Number(process.env.PAYMENT_CHAIN_ID) : undefined;

  const demoMock = isDemoMock();
  const allowMock = opts.allowMock === true;

  // Auth wallet.
  let authWallet: EvmWalletProvider | NoopWalletProvider;
  if (goatPrivateKey) {
    authWallet = createEvmWalletProvider({
      rpcUrl: cfg.rpcUrl,
      privateKey: goatPrivateKey,
      networkName: networkKey,
    });
  } else if (demoMock || allowMock) {
    authWallet = new NoopWalletProvider('0x0000000000000000000000000000000000000001', {
      networkName: networkKey,
      chainId: cfg.chainId,
    });
  } else {
    throw new Error(
      'createWalletPair: missing GOAT_PRIVATE_KEY (set DEMO_MOCK=true or supply a key).',
    );
  }

  // Payment wallet — distinct only when PAYMENT_CHAIN_RPC_URL is set.
  let paymentWallet: EvmWalletProvider | NoopWalletProvider;
  if (paymentRpc && paymentPrivateKey) {
    paymentWallet = createEvmWalletProvider({
      rpcUrl: paymentRpc,
      privateKey: paymentPrivateKey,
      networkName: paymentChainId ? `evm-${paymentChainId}` : 'payment-chain',
    });
  } else if (demoMock) {
    // Mock the payment wallet ONLY in explicit DEMO_MOCK. We deliberately do
    // NOT honor `allowMock` here: read-only commands pass allowMock so they
    // work without a key, but a real `buy` must never sign payOrder with a
    // Noop wallet. Without a payment RPC, fall through to the real auth wallet
    // (GOAT-native single-signer flow).
    paymentWallet = new NoopWalletProvider('0x0000000000000000000000000000000000000001', {
      networkName: 'payment-chain',
      chainId: paymentChainId ?? 8453,
    });
  } else {
    // Fall back to the auth wallet (GOAT-native flows use a single signer);
    // if auth is itself Noop (read-only, no key) the payment wallet is unused.
    paymentWallet = authWallet;
  }

  return { authWallet, paymentWallet };
}
