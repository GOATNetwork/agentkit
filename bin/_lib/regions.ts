/**
 * Region (country) discovery for the giftcard CLI.
 *
 * The public giftcard API has no endpoint that enumerates supported
 * countries (`/countries` is admin-only). The only public signal is the
 * `country` filter on `GET /brands`. So we probe a curated candidate list
 * in parallel and keep the codes that actually return brands. This
 * auto-discovers new regions as the backend adds them, without needing
 * admin credentials or a bundled static list.
 */
import type { GiftcardGateway } from '../../plugins/giftcard/adapters/types';

/** ISO 3166-1 alpha-2 → display name. Cheap to extend; probed in parallel. */
export const CANDIDATE_COUNTRIES: Record<string, string> = {
  US: 'United States',
  CA: 'Canada',
  GB: 'United Kingdom',
  AU: 'Australia',
  DE: 'Germany',
  FR: 'France',
  JP: 'Japan',
  MX: 'Mexico',
  BR: 'Brazil',
  IN: 'India',
  SG: 'Singapore',
  KR: 'South Korea',
};

export interface DiscoveredRegion {
  code: string;
  name: string;
  brandCount: number;
}

/**
 * Probe every candidate country and return only those whose brand catalog
 * is non-empty, sorted by display name. Per-country failures are ignored
 * so one bad code never fails the whole discovery.
 */
export async function discoverRegions(gateway: GiftcardGateway, signal?: AbortSignal): Promise<DiscoveredRegion[]> {
  const codes = Object.keys(CANDIDATE_COUNTRIES);
  const results = await Promise.allSettled(codes.map((code) => gateway.listBrands({ country: code }, signal)));

  const live: DiscoveredRegion[] = [];
  results.forEach((result, i) => {
    if (result.status === 'fulfilled' && Array.isArray(result.value) && result.value.length > 0) {
      const code = codes[i];
      live.push({ code, name: CANDIDATE_COUNTRIES[code], brandCount: result.value.length });
    }
  });
  live.sort((a, b) => a.name.localeCompare(b.name));
  return live;
}
