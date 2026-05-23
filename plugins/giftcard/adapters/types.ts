/**
 * Giftcard plugin adapter interfaces and shared request/response types.
 *
 * These types intentionally mirror the backend wire format (snake_case)
 * so the plugin action layer is a thin Zod-validated wrapper around
 * documented HTTP shapes. See:
 *   - gift-api/internal/api/orders.go            (createOrder request body)
 *   - gift-fe/src/app/lib/api-types.ts           (frontend mappings)
 *
 * The adapter layer is the boundary where authentication, single-flight,
 * and Redis-backed coordination live. Actions only touch the
 * `GiftcardGateway` interface, which is auth-agnostic by design.
 */

export type GiftcardCountry = 'US' | 'CA' | string;

export type GiftcardFaceValueType = 'FIXED' | 'VARIABLE';

export type GiftcardOrderStatus =
  | 'CREATED'
  | 'PAYMENT_PENDING'
  | 'PAYMENT_CONFIRMED'
  | 'FULFILLING'
  | 'FULFILLMENT_POLLING'
  | 'FULFILLED'
  | 'FAILED'
  | 'EXPIRED'
  | 'REFUNDING'
  | 'REFUNDED'
  | 'REFUND_FAILED';

export type GiftcardPayTokenSymbol = 'USDC' | 'USDT';

/* ---------------------------------------------------------------- */
/*  Brand / product / category                                      */
/* ---------------------------------------------------------------- */

export interface Brand {
  id: string;
  snaplii_brand_id?: string;
  country: GiftcardCountry;
  category_id?: string | null;
  name: string;
  description?: string | null;
  logo_url: string;
  product_count: number;
}

export interface BrandListParams {
  country?: string;
  category?: string;
  lang?: string;
}

export interface ProductSummary {
  product_id: string;
  name: string;
  face_value_type: GiftcardFaceValueType;
  face_value_min: number;
  face_value_max: number;
  face_value_min_local?: number;
  face_value_max_local?: number;
  currency_local?: string;
  sell_price_usd?: number;
  sell_markup_pct?: number;
  snaplii_discount?: number;
  image_url?: string;
  sold_out?: boolean;
  unavailable_reason?: string;
  max_buyable_face_value?: number;
  /**
   * FIXED-only denominations. Backend returns `[min, max]` when both are
   * non-zero in the catalog, but consumers should treat this as an
   * authoritative list when present.
   */
  denominations?: number[];
}

export interface BrandDetails {
  brand: {
    id: string;
    name: string;
    description?: string | null;
    logo_url: string;
    country: GiftcardCountry;
    currency_local?: string;
    fx_rate_to_usd?: number;
    category_id?: string | null;
  };
  products: ProductSummary[];
}

export interface Category {
  id: string;
  name: string;
}

/* ---------------------------------------------------------------- */
/*  Tokens                                                          */
/* ---------------------------------------------------------------- */

export interface SupportedToken {
  chain_id: number;
  token_symbol: GiftcardPayTokenSymbol;
  token_contract: string;
  decimals: number;
  chain_name?: string;
}

export interface SupportedTokensResponse {
  tokens: SupportedToken[];
}

/* ---------------------------------------------------------------- */
/*  Orders                                                          */
/* ---------------------------------------------------------------- */

/**
 * The exact JSON body that the Go backend's POST /api/v1/orders
 * accepts. See gift-api/internal/api/orders.go:19-26.
 *
 * snake_case is non-negotiable here — the backend uses
 * `c.BodyParser(&req)` with explicit `json:"..."` tags.
 */
export interface CreateOrderInput {
  product_id: string;
  face_value: number;
  pay_chain_id: number;
  pay_token_symbol: GiftcardPayTokenSymbol;
  idempotency_key: string;
}

export interface OrderCard {
  card_code?: string | null;
  card_pin?: string | null;
  card_link?: string | null;
  card_barcode?: string | null;
}

export interface OrderRefund {
  reason?: string | null;
  status?: string | null;
  tx_hash?: string | null;
  amount_usd?: number | null;
}

/**
 * Order record returned by createOrder / getOrder / listOrders.
 *
 * The shape matches `buildOrderResponse` in
 * gift-api/internal/api/orders.go:504; we keep it permissive (every
 * non-canonical field is optional) so a backend addition is non-breaking
 * for the SDK.
 */
export interface OrderRecord {
  order_id: string;
  status: GiftcardOrderStatus | string;
  product_id: string;
  card_brand_name: string;
  country: GiftcardCountry;
  face_value: number;
  face_value_local?: number | null;
  currency_local?: string | null;
  face_value_type: GiftcardFaceValueType;
  sell_price_usd: number;
  fx_rate_used?: number | null;
  pay_amount_usd?: number;
  pay_amount_wei?: string;
  pay_chain_id: number;
  pay_token_symbol: GiftcardPayTokenSymbol;
  pay_token_contract?: string;
  pay_token_decimals?: number;
  x402_order_id?: string | null;
  pay_to_address?: string | null;
  dapp_order_id?: string;
  x402_tx_hash?: string | null;
  paid_at?: number;
  expire_at?: number;
  created_at: number;
  updated_at?: number;
  card?: OrderCard | null;
  refund?: OrderRefund | null;
  /**
   * Flattened card secrets — populated by the giftcard action layer
   * (NOT the backend) so the runtime's shallow `sensitiveOutputFields`
   * redaction reaches them. Mirrors `card.{card_code,...}`.
   */
  card_code?: string;
  card_pin?: string;
  card_link?: string;
  card_barcode?: string;
}

export interface OrderListParams {
  status?: GiftcardOrderStatus | 'ALL';
  limit?: number;
  offset?: number;
}

export interface OrderListResponse {
  orders: OrderRecord[];
  total: number;
}

/* ---------------------------------------------------------------- */
/*  Gateway / auth interfaces                                       */
/* ---------------------------------------------------------------- */

export interface GiftcardGateway {
  listBrands(params?: BrandListParams, signal?: AbortSignal): Promise<Brand[]>;
  getBrand(id: string, lang?: string, signal?: AbortSignal): Promise<BrandDetails>;
  listCategories(lang?: string, signal?: AbortSignal): Promise<Category[]>;
  listSupportedTokens(signal?: AbortSignal): Promise<SupportedTokensResponse>;
  createOrder(input: CreateOrderInput, signal?: AbortSignal): Promise<OrderRecord>;
  getOrder(id: string, signal?: AbortSignal): Promise<OrderRecord>;
  listOrders(params?: OrderListParams, signal?: AbortSignal): Promise<OrderListResponse>;
}

export interface Eip712AuthDomain {
  name: string;
  version: string;
  chainId: number;
}

export interface AuthMessage {
  address: string;
  nonce: bigint | number | string;
  expiry: bigint | number | string;
}

export interface AuthSigner {
  getAddress(): Promise<string>;
  signAuth(domain: Eip712AuthDomain, message: AuthMessage): Promise<string>;
}

/**
 * Auth token cache contract.
 *
 * `expiresAt` is Unix MILLISECONDS (matching `Date.now()`). Implementers
 * MUST convert the backend's `expire_at` (seconds) before calling
 * `set()`. The cache should consider a token expired when
 * `Date.now() >= expiresAt`.
 */
export interface AuthCache {
  get(address: string): Promise<{ token: string; expiresAt: number } | null>;
  set(address: string, token: string, expiresAt: number): Promise<void>;
  clear(address: string): Promise<void>;
}

/**
 * Minimal subset of the ioredis client surface the adapter uses for the
 * optional distributed single-flight lock. Kept as a structural type
 * rather than a direct `Redis` import so consumers can plug any
 * compatible client (ioredis, mock, custom).
 */
export interface GiftcardRedisClient {
  set(
    key: string,
    value: string,
    mode: 'PX',
    ttlMs: number,
    flag: 'NX',
  ): Promise<'OK' | null>;
  del(key: string): Promise<number>;
  /**
   * Optional. When present, the adapter uses GET+DEL as a best-effort
   * check-and-delete on lock release, so a process whose TTL has expired
   * does not delete the lock another process has since acquired. ioredis
   * exposes `get` natively; mock/custom clients may omit it (the release
   * then becomes a no-op and the TTL reaps the lock).
   */
  get?(key: string): Promise<string | null>;
}
