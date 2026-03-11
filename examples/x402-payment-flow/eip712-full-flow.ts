import { Wallet } from 'ethers';
import { EvmPayerWalletAdapter } from '../../plugins/x402/adapters/evm-payer-wallet';
import type { MerchantGatewayAdapter } from '../../plugins/x402/adapters/types';

class MockMerchantGateway implements MerchantGatewayAdapter {
  async createPaymentIntent() {
    return {
      paymentId: `order_${Date.now()}`,
      status: 'created' as const,
      calldataSignRequest: {
        domain: {
          name: 'GoatX402',
          version: '1',
          chainId: 2345,
          verifyingContract: '0x0000000000000000000000000000000000000001',
        },
        types: {
          Eip3009CallbackData: [
            { name: 'payer', type: 'address' },
            { name: 'amount', type: 'uint256' },
            { name: 'orderId', type: 'string' },
          ],
        },
        primaryType: 'Eip3009CallbackData',
        message: {
          payer: '0x000000000000000000000000000000000000dEaD',
          amount: '1000000',
          orderId: 'demo-order',
        },
      },
    };
  }

  async getPaymentStatus(paymentId: string) {
    return { paymentId, status: 'authorized' as const };
  }

  async submitPaymentAuthorization(paymentId: string, signature: string) {
    return { paymentId, status: signature.startsWith('0x') ? ('authorized' as const) : ('failed' as const) };
  }

  async cancelPayment(paymentId: string) {
    return { paymentId, status: 'cancelled' as const };
  }
}

async function main() {
  const merchant = new MockMerchantGateway();
  const signer = Wallet.createRandom();
  const payer = new EvmPayerWalletAdapter(signer);

  const created = await merchant.createPaymentIntent({ to: '0xabc', asset: 'USDC', amount: '1000000' });
  const signature = await payer.signCalldataTypedData(created.calldataSignRequest!);
  const authorized = await merchant.submitPaymentAuthorization(created.paymentId, signature);
  const status = await merchant.getPaymentStatus(created.paymentId);

  console.log({ paymentId: created.paymentId, signature: `${signature.slice(0, 12)}...`, authorized, status });
}

main().catch(console.error);
