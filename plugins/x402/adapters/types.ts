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
  getPaymentStatus(paymentId: string, signal?: AbortSignal): Promise<{ paymentId: string; status: PaymentStatus; raw?: unknown }>;
  submitPaymentAuthorization(paymentId: string, signature: string, signal?: AbortSignal): Promise<{ paymentId: string; status: 'authorized' | 'failed'; raw?: unknown }>;
  cancelPayment(paymentId: string, signal?: AbortSignal): Promise<{ paymentId: string; status: 'cancelled' | 'failed'; raw?: unknown }>;
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
}
