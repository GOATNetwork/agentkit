/**
 * GOAT Flow API live smoke test (testnet3 / mainnet)
 *
 * Calls GoatAdapter's x402 methods against the real GOAT Flow API to verify,
 * after the domain switch (api.goatx402.com -> flow-api[.testnet3].goat.network):
 *   1) the domain is reachable (DNS/TLS/connectivity)
 *   2) requests hit `<base>/api/v1/orders`, with base selected per network
 *   3) the HMAC signing headers (X-API-Key / X-Timestamp / X-Nonce / X-Sign)
 *      are present and accepted by the backend
 *
 * How it works: stub globalThis.fetch, clone the response to capture
 * URL/headers/status/body, then pass the original through to the adapter. So
 * even when the order params don't match your merchant (400/402/404), it can
 * still tell apart "reachable + signing OK" from "auth failed":
 *   - 200 / 402       -> OK: reachable + auth/signature accepted (402 is the
 *                        x402 "payment required" expected response)
 *   - 401 / 403       -> auth/signature rejected (check KEY/SECRET, clock skew)
 *   - 400 / 404 / 422 -> reached & authenticated; only the order params /
 *                        merchant config are off (still a pass for this change)
 *   - fetch throws    -> domain unreachable (connectivity / TLS / DNS)
 *
 * Usage:
 *   GOAT_X402_API_KEY=... GOAT_X402_API_SECRET=... \
 *   [GOAT_NETWORK=goat-testnet] [GOAT_X402_BASE_URL=...(override; defaults per network)] \
 *   [GOATFLOW_SMOKE_ASSET=USDT] [GOATFLOW_SMOKE_AMOUNT=1000000] [GOATFLOW_SMOKE_TO=0x...] \
 *   npx tsx scripts/goatflow-smoke.ts
 */
import { GoatAdapter } from '../networks/goat/adapter';

type Net = 'goat-mainnet' | 'goat-testnet';

const network: Net =
  (process.env.GOAT_NETWORK as Net | undefined) ?? 'goat-testnet';
const apiKey = process.env.GOAT_X402_API_KEY;
const apiSecret = process.env.GOAT_X402_API_SECRET;

// Order params (override via env to match your merchant config).
const asset = process.env.GOATFLOW_SMOKE_ASSET ?? 'USDT';
const amount = process.env.GOATFLOW_SMOKE_AMOUNT ?? '1000000';
const to =
  process.env.GOATFLOW_SMOKE_TO ??
  '0x000000000000000000000000000000000000dEaD';

function fail(msg: string): never {
  console.error(`\n[FAIL] ${msg}`);
  process.exit(1);
}

if (!apiKey || !apiSecret) {
  console.error(
    [
      '\n[SKIP] Missing credentials; no network request was made.',
      '',
      'You need the API credentials of a merchant on flow testnet3:',
      '  export GOAT_X402_API_KEY=<your key>',
      '  export GOAT_X402_API_SECRET=<your secret>',
      '',
      '(Credentials come from the GOAT Flow merchant/admin portal; the full',
      ' DELEGATE callback flow additionally requires a DELEGATE merchant.)',
      'Then re-run: npx tsx scripts/goatflow-smoke.ts',
    ].join('\n'),
  );
  process.exit(2);
}

interface Captured {
  url: string;
  headers: Record<string, string>;
  status: number;
  bodyText: string;
}

let captured: Captured | undefined;
let fetchError: unknown;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input);
  const headers: Record<string, string> = { ...(init?.headers ?? {}) };
  try {
    const resp = await realFetch(input, init);
    let bodyText = '';
    try {
      bodyText = await resp.clone().text();
    } catch {
      /* non-text response; ignore */
    }
    captured = { url, headers, status: resp.status, bodyText };
    return resp;
  } catch (e) {
    fetchError = e;
    captured = { url, headers, status: -1, bodyText: '' };
    throw e;
  }
}) as typeof fetch;

function has(h: Record<string, string>, name: string): boolean {
  return Object.keys(h).some((k) => k.toLowerCase() === name.toLowerCase());
}

async function main(): Promise<void> {
  const adapter = new GoatAdapter(network);
  console.log('-- GOAT Flow smoke --');
  console.log(`network : ${network}`);
  console.log(`asset   : ${asset}   amount_wei: ${amount}   to: ${to}`);
  console.log('Calling x402CreatePayment (POST /api/v1/orders)...\n');

  let adapterError: unknown;
  try {
    const res = await adapter.x402CreatePayment({ to, asset, amount });
    console.log('adapter returned:', JSON.stringify(res, null, 2));
  } catch (e) {
    adapterError = e;
  }

  if (!captured) {
    fail('adapter made no fetch call -- unexpected; check adapter logic.');
  }
  const c = captured!;

  // 1) Connectivity
  if (c.status === -1) {
    console.error(`\nRequest URL : ${c.url}`);
    fail(
      `Domain unreachable (fetch threw): ${
        fetchError instanceof Error ? fetchError.message : String(fetchError)
      }\n   -> connectivity / DNS / TLS issue, or wrong domain.`,
    );
  }

  // 2) URL / base selection
  const expectHost =
    network === 'goat-mainnet'
      ? 'https://flow-api.goat.network'
      : 'https://flow-api.testnet3.goat.network';
  const baseOverride = process.env.GOAT_X402_BASE_URL;
  const urlOk = baseOverride
    ? c.url.startsWith(baseOverride.replace(/\/+$/, ''))
    : c.url.startsWith(expectHost);
  console.log(`Request URL : ${c.url}`);
  console.log(
    `Domain/path : ${urlOk && c.url.includes('/api/v1/orders') ? 'OK' : 'FAIL'} ` +
      `${urlOk ? '(base correct)' : `(expected base ${baseOverride ?? expectHost})`}`,
  );

  // 3) Signing headers
  const sigHeaders = ['X-API-Key', 'X-Timestamp', 'X-Nonce', 'X-Sign'];
  const missing = sigHeaders.filter((h) => !has(c.headers, h));
  console.log(
    `Sig headers : ${missing.length === 0 ? 'OK (all present)' : `FAIL (missing ${missing.join(', ')})`} ` +
      `(${sigHeaders.filter((h) => has(c.headers, h)).join(', ')})`,
  );

  // 4) Status interpretation
  console.log(`HTTP status : ${c.status}`);
  if (c.bodyText) {
    console.log(
      `Body        : ${c.bodyText.slice(0, 400)}${c.bodyText.length > 400 ? '...' : ''}`,
    );
  }
  console.log('');

  if (c.status === 200 || c.status === 402) {
    console.log(
      '[PASS] domain reachable + auth/signature accepted by the backend ' +
        '(402 is the x402 "payment required" response).',
    );
  } else if (c.status === 401 || c.status === 403) {
    fail(
      `Auth/signature rejected (${c.status}): check GOAT_X402_API_KEY / ` +
        `GOAT_X402_API_SECRET, and whether the local clock is too far from the ` +
        `server (timestamp is part of the signature).`,
    );
  } else if ([400, 404, 409, 422].includes(c.status)) {
    console.log(
      `[WARN] reached & authenticated (${c.status}); only the order params / ` +
        `merchant config are off.` +
        `\n   For the "domain switch + signing" change: PASS.` +
        `\n   To place a full order, re-run with GOATFLOW_SMOKE_ASSET / _AMOUNT / _TO ` +
        `matching your merchant.`,
    );
  } else {
    console.log(
      `[WARN] reached the server, which returned ${c.status}${
        adapterError instanceof Error ? ` (adapter: ${adapterError.message})` : ''
      }. Not an auth failure, but inspect the body manually.`,
    );
  }
}

main().catch((e) => fail(e instanceof Error ? e.stack ?? e.message : String(e)));
