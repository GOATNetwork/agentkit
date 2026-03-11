import { HttpMerchantGatewayAdapter } from '../../plugins/x402/adapters/http-merchant-gateway';
import { NoopPayerWalletAdapter } from '../../plugins/x402/adapters/noop-payer-wallet';

export function initX402Gateway() {
  const baseUrl = process.env.MERCHANT_API_BASE_URL ?? 'https://merchant.example.com';
  const apiKey = process.env.MERCHANT_API_KEY;

  const merchant = new HttpMerchantGatewayAdapter(baseUrl, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    routes: {
      createOrderPath: process.env.MERCHANT_CREATE_ORDER_PATH ?? '/x402/create-order',
      orderStatusPath: process.env.MERCHANT_ORDER_STATUS_PATH ?? '/x402/order-status/:paymentId',
      submitSignaturePath: process.env.MERCHANT_SUBMIT_SIGNATURE_PATH ?? '/x402/submit-signature',
      cancelOrderPath: process.env.MERCHANT_CANCEL_ORDER_PATH ?? '/x402/cancel-order',
    },
  });

  const payer = new NoopPayerWalletAdapter();

  return { merchant, payer };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { merchant } = initX402Gateway();
  console.log('x402 merchant gateway initialized:', merchant.constructor.name);
}
