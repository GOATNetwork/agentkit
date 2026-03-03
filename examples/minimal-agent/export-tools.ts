import { ActionProvider } from '../../providers/action-provider';
import { createPaymentAction } from '../../plugins/x402/actions/payment.create';
import { submitSignatureAction } from '../../plugins/x402/actions/payment.submit-signature';
import { transferPaymentAction } from '../../plugins/x402/actions/payment.transfer';
import { paymentStatusAction } from '../../plugins/x402/actions/payment.status';
import { cancelPaymentAction } from '../../plugins/x402/actions/payment.cancel';
import { walletBalanceAction } from '../../plugins/wallet/actions/balance';
import { NoopPayerWalletAdapter } from '../../plugins/x402/adapters/noop-payer-wallet';
import { NoopWalletReadAdapter } from '../../plugins/wallet/adapters/types';
import type { MerchantGatewayAdapter } from '../../plugins/x402/adapters/types';

class MockMerchantGatewayAdapter implements MerchantGatewayAdapter {
  async createPaymentIntent() {
    return { paymentId: 'mock', status: 'created' as const };
  }
  async getPaymentStatus(paymentId: string) {
    return { paymentId, status: 'created' as const };
  }
  async submitPaymentAuthorization(paymentId: string) {
    return { paymentId, status: 'authorized' as const };
  }
  async cancelPayment(paymentId: string) {
    return { paymentId, status: 'cancelled' as const };
  }
}

const provider = new ActionProvider();
const merchant = new MockMerchantGatewayAdapter();
const payer = new NoopPayerWalletAdapter();
const walletRead = new NoopWalletReadAdapter();

provider.register(createPaymentAction(merchant));
provider.register(submitSignatureAction(merchant, payer));
provider.register(transferPaymentAction(payer));
provider.register(paymentStatusAction(merchant));
provider.register(cancelPaymentAction(merchant));
provider.register(walletBalanceAction(walletRead));

console.log('manifest:', provider.manifest());
console.log('openai tools:', provider.openAITools());
console.log('langchain defs:', provider.langChainToolDefs());
