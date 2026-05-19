/**
 * Shared `doctor` subcommand implementation.
 *
 * Reports three buckets per CLI:
 *   - env: which env vars are SET / MISSING.
 *   - api: HEAD/GET against the configured API base URL, returns http status.
 *   - wallet: if a private key is present, build the wallet and call
 *             getChainId() to confirm the RPC is reachable.
 *
 * Exit 0 if all configured checks pass; exit 1 if any FAIL.
 * Never throws — surfaces a structured `DoctorReport`.
 */
import { goatNetworks } from '../../networks/goat/config';
import { createEvmWalletProvider } from './wallet-from-env';

export interface DoctorEnvCheck {
  name: string;
  set: boolean;
  /** Masked value (truncated/redacted) when present. */
  value?: string;
  required?: boolean;
}

export interface DoctorApiCheck {
  url: string;
  ok: boolean;
  status?: number;
  error?: string;
}

export interface DoctorWalletCheck {
  configured: boolean;
  network: string;
  rpcUrl: string;
  address?: string;
  chainId?: number;
  ok: boolean;
  error?: string;
}

export interface DoctorReport {
  env: DoctorEnvCheck[];
  api: DoctorApiCheck;
  wallet: DoctorWalletCheck;
  ok: boolean;
}

function mask(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function envCheck(name: string, required = false): DoctorEnvCheck {
  const raw = process.env[name];
  const set = raw != null && raw !== '';
  return {
    name,
    set,
    required,
    value: set ? (name.toLowerCase().includes('key') || name.toLowerCase().includes('token') ? mask(raw) : raw) : undefined,
  };
}

async function pingApi(url: string, timeoutMs = 5000): Promise<DoctorApiCheck> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { method: 'GET', signal: controller.signal });
    return { url, ok: resp.status < 500, status: resp.status };
  } catch (err) {
    return { url, ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function checkWallet(networkKey: 'goat-mainnet' | 'goat-testnet'): Promise<DoctorWalletCheck> {
  const cfg = goatNetworks[networkKey];
  const pk = process.env.GOAT_PRIVATE_KEY;
  if (!pk) {
    return {
      configured: false,
      network: networkKey,
      rpcUrl: cfg.rpcUrl,
      ok: false,
      error: 'GOAT_PRIVATE_KEY not set; cannot test wallet',
    };
  }
  try {
    const wallet = createEvmWalletProvider({
      rpcUrl: cfg.rpcUrl,
      privateKey: pk,
      networkName: networkKey,
    });
    const [address, chainId] = await Promise.all([wallet.getAddress(), wallet.getChainId()]);
    if (chainId !== cfg.chainId) {
      return {
        configured: true,
        network: networkKey,
        rpcUrl: cfg.rpcUrl,
        address,
        chainId,
        ok: false,
        error: `chainId mismatch: wallet reports ${chainId}, expected ${cfg.chainId}`,
      };
    }
    return {
      configured: true,
      network: networkKey,
      rpcUrl: cfg.rpcUrl,
      address,
      chainId,
      ok: true,
    };
  } catch (err) {
    return {
      configured: true,
      network: networkKey,
      rpcUrl: cfg.rpcUrl,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface DoctorOptions {
  envVars: Array<{ name: string; required?: boolean }>;
  apiUrl: string;
  network: 'goat-mainnet' | 'goat-testnet';
}

export async function runDoctor(opts: DoctorOptions): Promise<DoctorReport> {
  const env = opts.envVars.map((v) => envCheck(v.name, v.required));
  const [api, wallet] = await Promise.all([pingApi(opts.apiUrl), checkWallet(opts.network)]);

  // Determine overall ok:
  // - all REQUIRED env vars must be set
  // - api must be reachable (status < 500 or any response)
  // - wallet: if configured, must succeed. If not configured, doesn't block.
  const envOk = env.filter((e) => e.required).every((e) => e.set);
  const walletOk = !wallet.configured || wallet.ok;
  const overallOk = envOk && api.ok && walletOk;

  return { env, api, wallet, ok: overallOk };
}
