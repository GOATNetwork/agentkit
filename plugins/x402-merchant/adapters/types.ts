/** Per-request options for merchant portal HTTP methods. */
export interface RequestOptions {
  signal?: AbortSignal;
  /** Per-request bearer token; takes precedence over the client's stored token. */
  accessToken?: string;
}

/**
 * Generic HTTP client interface for the x402 Merchant Portal API.
 * All merchant portal actions use this client to make authenticated requests.
 */
export interface MerchantPortalClient {
  /** Set the default bearer access token for authenticated requests. */
  setAccessToken(token: string): void;

  /** Get the current default access token (if any). */
  getAccessToken(): string | undefined;

  /** Make a GET request. */
  get<T = any>(path: string, options?: RequestOptions): Promise<T>;

  /** Make a POST request with optional JSON body. */
  post<T = any>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;

  /** Make a PUT request with optional JSON body. */
  put<T = any>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;

  /** Make a DELETE request. */
  delete<T = any>(path: string, options?: RequestOptions): Promise<T>;
}
