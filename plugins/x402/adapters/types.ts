export type PaymentStatus = 'created' | 'authorized' | 'settled' | 'failed' | 'expired';

export interface Eip712TypeField {
  name: string;
  type: string;
}

export interface CalldataSignRequest {
  domain: Record<string, unknown>;
  types: Record<string, Eip712TypeField[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface CreatePaymentIntentInput {
  to: string;
  asset: string;
  amount: string;
  fromAddress?: string;
  idempotencyKey?: string;
  callbackCalldata?: string;
}

export interface CreatePaymentIntentResult {
  paymentId: string;
  status: 'created';
  payToAddress?: string;
  tokenAddress?: string;
  calldataSignRequest?: CalldataSignRequest;
  raw?: unknown;
}

export interface MerchantGatewayAdapter {
  createPaymentIntent(input: CreatePaymentIntentInput, signal?: AbortSignal): Promise<CreatePaymentIntentResult>;
  getPaymentStatus(
    paymentId: string,
    signal?: AbortSignal,
  ): Promise<{ paymentId: string; status: PaymentStatus; raw?: unknown }>;
  submitPaymentAuthorization(
    paymentId: string,
    signature: string,
    signal?: AbortSignal,
  ): Promise<{ paymentId: string; status: 'authorized' | 'failed'; raw?: unknown }>;
  cancelPayment(
    paymentId: string,
    signal?: AbortSignal,
  ): Promise<{ paymentId: string; status: 'cancelled' | 'failed'; raw?: unknown }>;
}

export interface TransferTokenInput {
  tokenAddress: string;
  to: string;
  amount: string;
}

export interface TransferTokenResult {
  txHash: string;
}

export interface PayerWalletAdapter {
  normalizeAuthorization(input: string): Promise<string>;
  signCalldataTypedData(request: CalldataSignRequest): Promise<string>;
  transferToken(input: TransferTokenInput, signal?: AbortSignal): Promise<TransferTokenResult>;
  /**
   * Optional: chainId of the signer that will broadcast `transferToken`.
   * Cross-chain actions (e.g. `goat.gns.x402.payOrder`) MUST validate the
   * payer's chain matches the order's `payChainId` — checking only the
   * adjacent `WalletProvider.getChainId()` is insufficient when `wallet`
   * and `payer` are constructed from different signers.
   */
  getChainId?(): Promise<number>;
  /**
   * Optional: address of the signer that will broadcast `transferToken`.
   * Issue #3 R4 (Codex P5): cross-chain actions that bind the
   * `calldataSignRequest.message.payer` field MUST compare against the
   * adapter that actually broadcasts the transfer — checking only
   * `WalletProvider.getAddress()` is insufficient when `wallet` and `payer`
   * wrap different signers. If implemented, `goat.gns.x402.payOrder`
   * enforces a 3-way match: `wallet.getAddress()` ≡ `payer.getAddress()` ≡
   * `message.payer`. Adapters MAY omit this; the action falls back to
   * the wallet check alone (with reduced confidence noted in the action's
   * trust-model docstring).
   */
  getAddress?(): Promise<string>;
}
