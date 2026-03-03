export interface TokenEntry {
  symbol: string;
  address: string;
  name: string;
}

export type TokenSymbol = 'WGBTC' | 'GOAT' | 'BRIDGE' | 'BITCOIN' | 'OKU_SWAP_ROUTER' | 'OKU_QUOTER' | 'OKU_POSITION_MANAGER' | 'OKU_FACTORY' | 'LZ_ENDPOINT';

export const GOAT_TOKENS: Record<TokenSymbol, TokenEntry> = {
  WGBTC: {
    symbol: 'WGBTC',
    address: '0xBC10000000000000000000000000000000000000',
    name: 'Wrapped GOAT BTC',
  },
  GOAT: {
    symbol: 'GOAT',
    address: '0xbC10000000000000000000000000000000000001',
    name: 'Goat Token',
  },
  BRIDGE: {
    symbol: 'BRIDGE',
    address: '0xBC10000000000000000000000000000000000003',
    name: 'Bridge',
  },
  BITCOIN: {
    symbol: 'BITCOIN',
    address: '0xbC10000000000000000000000000000000000005',
    name: 'Bitcoin Oracle',
  },
  OKU_SWAP_ROUTER: {
    symbol: 'OKU_SWAP_ROUTER',
    address: '0xaa52bB8110fE38D0d2d2AF0B85C3A3eE622CA455',
    name: 'OKU SwapRouter02',
  },
  OKU_QUOTER: {
    symbol: 'OKU_QUOTER',
    address: '0x5911cB3633e764939edc2d92b7e1ad375Bb57649',
    name: 'OKU QuoterV2',
  },
  OKU_POSITION_MANAGER: {
    symbol: 'OKU_POSITION_MANAGER',
    address: '0x743E03cceB4af2efA3CC76838f6E8B50B63F184c',
    name: 'OKU PositionManager',
  },
  OKU_FACTORY: {
    symbol: 'OKU_FACTORY',
    address: '0xcb2436774C3e191c85056d248EF4260ce5f27A9D',
    name: 'OKU V3Factory',
  },
  LZ_ENDPOINT: {
    symbol: 'LZ_ENDPOINT',
    address: '0x6F475642a6e85809B1c36Fa62763669b1b48DD5B',
    name: 'LayerZero Endpoint V2',
  },
};

export function resolveTokenAddress(symbol: string): TokenEntry {
  const upper = symbol.toUpperCase() as TokenSymbol;
  const entry = GOAT_TOKENS[upper];
  if (!entry) {
    const known = Object.keys(GOAT_TOKENS).join(', ');
    throw new Error(`Unknown token symbol "${symbol}". Known symbols: ${known}`);
  }
  return entry;
}
