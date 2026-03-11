// Adapter
export type { MerchantPortalClient } from './adapters/types';
export { HttpMerchantPortalClient } from './adapters/http-client';
export type { HttpMerchantPortalClientOptions } from './adapters/http-client';

// Auth
export { merchantAuthRegisterAction } from './actions/auth.register';
export { merchantAuthRegisterInviteAction } from './actions/auth.register-invite';
export { merchantAuthLoginAction } from './actions/auth.login';
export { merchantAuthRefreshAction } from './actions/auth.refresh';

// Dashboard
export { merchantDashboardStatsAction } from './actions/dashboard.stats';

// Profile
export { merchantProfileGetAction } from './actions/profile.get';
export { merchantProfileUpdateAction } from './actions/profile.update';

// Orders
export { merchantOrdersListAction } from './actions/orders.list';
export { merchantOrdersGetAction } from './actions/orders.get';

// Balance & Fees
export { merchantBalanceGetAction } from './actions/balance.get';
export { merchantBalanceTransactionsAction } from './actions/balance.transactions';
export { merchantBalanceFeesConfigAction } from './actions/balance.fees-config';

// Supported Tokens
export { merchantSupportedTokensListAction } from './actions/supported-tokens.list';

// Receiving Addresses
export { merchantAddressesListAction } from './actions/addresses.list';
export { merchantAddressesAddAction } from './actions/addresses.add';
export { merchantAddressesRemoveAction } from './actions/addresses.remove';

// Callback Contracts (DELEGATE mode)
export { merchantCallbackContractsListAction } from './actions/callback-contracts.list';
export { merchantCallbackContractsSubmitAction } from './actions/callback-contracts.submit';
export { merchantCallbackContractsRemoveAction } from './actions/callback-contracts.remove';
export { merchantCallbackContractsCancelSubmissionAction } from './actions/callback-contracts.cancel-submission';

// API Keys
export { merchantApiKeysGetAction } from './actions/api-keys.get';
export { merchantApiKeysRotateAction } from './actions/api-keys.rotate';

// Webhooks
export { merchantWebhooksListAction } from './actions/webhooks.list';
export { merchantWebhooksCreateAction } from './actions/webhooks.create';
export { merchantWebhooksUpdateAction } from './actions/webhooks.update';
export { merchantWebhooksDeleteAction } from './actions/webhooks.delete';

// Invite Codes
export { merchantInviteCodesListAction } from './actions/invite-codes.list';
export { merchantInviteCodesCreateAction } from './actions/invite-codes.create';
export { merchantInviteCodesRevokeAction } from './actions/invite-codes.revoke';

// Audit Logs
export { merchantAuditLogsListAction } from './actions/audit-logs.list';
