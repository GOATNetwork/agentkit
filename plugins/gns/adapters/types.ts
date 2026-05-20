import type { CalldataSignRequest } from '../../x402/adapters/types';

/**
 * GNS HTTP API + on-chain helper types.
 *
 * All response shapes mirror the production gns-api responses
 * (https://gns-api.{,testnet3.}goat.network/api). Where a field is optional
 * the API may omit it depending on the name's lifecycle stage.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Public API response shapes
// ─────────────────────────────────────────────────────────────────────────────

export type SearchStatus = 'available' | 'registered' | 'unsupported';

export interface SearchResultItem {
  name: string;
  status: SearchStatus;
  label?: string;
  route?: string;
}

export interface SearchResponse {
  query: string;
  normalizedQuery: string;
  results: SearchResultItem[];
}

export type NameLifecycle = 'available' | 'active' | 'grace-period';

export interface NameDetailsRecord {
  key: string;
  value: string;
  shortValue?: string;
  coinType?: string;
  editable?: boolean;
  format?: string;
}

export interface NameDetailsResponse {
  name: string;
  node: string;
  status: 'available' | 'registered';
  lifecycleStatus: NameLifecycle;
  owner: string;
  ownerAddress: `0x${string}`;
  resolver: string;
  resolverAddress: `0x${string}`;
  expiry: string;
  gracePeriodEnds: string;
  tokenId: string;
  registrationDate: string;
  primaryName: boolean;
  avatar?: string | null;
  description?: string | null;
  website?: string | null;
  email?: string | null;
  // Production API returns an array of social network keys (e.g. ['twitter',
  // 'github']); older shapes used a key→handle map. Accept both.
  socialLinks?: string[] | Record<string, string>;
  records: NameDetailsRecord[];
}

export interface QuoteInput {
  name: string;
  years: number;
  tokenContract?: `0x${string}`;
}

export interface RegistrationQuoteResponse {
  name: string;
  years: number;
  /** Duration in seconds, base-10 integer string (BigInt-serialised). */
  durationSeconds: string;
  currency: string;
  decimals: number;
  registrationFee: string;
  estimatedGas: string;
  total: string;
  /** Total payment in token base units (e.g. wei), base-10 integer string. */
  totalWei: string;
}

export interface MyNamesItem {
  name: string;
  tokenId: string;
  expiry: string;
  isPrimary?: boolean;
}

export interface MyNamesResponse {
  address: `0x${string}`;
  total: number;
  items: MyNamesItem[];
}

// ─────────────────────────────────────────────────────────────────────────────
// x402 payment shapes
// ─────────────────────────────────────────────────────────────────────────────

export interface X402TokenConfig {
  symbol: string;
  contract: `0x${string}`;
  decimals: number;
}

export interface X402ChainConfig {
  chainId: number;
  name: string;
  tokens: X402TokenConfig[];
}

export interface X402MerchantConfigResponse {
  merchantId: string;
  merchantName: string;
  receiveType: 'DELEGATE' | string;
  chains: X402ChainConfig[];
}

export interface CreateX402OrderInput {
  name: string;
  owner: `0x${string}`;
  payer: `0x${string}`;
  years: number;
  settlementChainId: number;
  settlementTokenSymbol: string;
  settlementTokenContract: `0x${string}`;
  secret: `0x${string}`;
  commitment?: `0x${string}`;
  /** Optional pinned commit-bound max amount; see backend payments.service.ts:309. */
  commitMaxAmountWei?: string;
}

export type X402OrderFlow = 'ERC20_3009' | 'ERC20_TRANSFER' | string;

/**
 * Response from POST /payments/x402/register-order.
 *
 * `calldataSignRequest` mirrors the shape produced by the upstream GoatX402
 * service. The plugin's x402.createOrder action exposes it verbatim; the
 * x402.submitSignature action signs it with the configured payer adapter.
 */
export interface X402OrderResponse {
  orderId: string;
  flow: X402OrderFlow;
  payToAddress: `0x${string}`;
  expiresAt: number;
  chainId: number;
  /** Settlement chain numeric id (= `chainId` from the API). */
  payChainId: number;
  tokenSymbol: string;
  tokenContract: `0x${string}`;
  fromAddress: `0x${string}`;
  amountWei: string;
  callbackCalldata: string;
  calldataSignRequest: CalldataSignRequest;
}

export type X402OrderLifecycle =
  | 'CHECKOUT_VERIFIED'
  | 'PAYMENT_PENDING'
  | 'PAYMENT_CONFIRMED'
  | 'INVOICED'
  | 'FAILED'
  | 'EXPIRED'
  | 'CANCELLED'
  | string;

export interface X402OrderStatusResponse {
  orderId: string;
  status: X402OrderLifecycle;
  txHash?: string;
  confirmedAt?: number;
  raw?: unknown;
}

export interface X402SubmitSignatureResponse {
  status: 'authorized' | 'failed';
  raw?: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapter contract
// ─────────────────────────────────────────────────────────────────────────────

export interface GnsApiAdapter {
  search(query: string, signal?: AbortSignal): Promise<SearchResponse>;
  details(name: string, signal?: AbortSignal): Promise<NameDetailsResponse>;
  quote(input: QuoteInput, signal?: AbortSignal): Promise<RegistrationQuoteResponse>;
  myNames(address: string, signal?: AbortSignal): Promise<MyNamesResponse>;
  x402Config(signal?: AbortSignal): Promise<X402MerchantConfigResponse>;
  createX402Order(input: CreateX402OrderInput, signal?: AbortSignal): Promise<X402OrderResponse>;
  getX402Order(orderId: string, signal?: AbortSignal): Promise<X402OrderStatusResponse>;
  submitX402Signature(
    orderId: string,
    signature: string,
    signal?: AbortSignal,
  ): Promise<X402SubmitSignatureResponse>;
}

// Re-export for consumer convenience.
export type { CalldataSignRequest };
