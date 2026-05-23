// Actions
export { checkAvailabilityAction as gnsCheckAvailabilityAction } from './actions/check-availability';
export { getNameDetailsAction as gnsGetNameDetailsAction } from './actions/get-name-details';
export { getMyNamesAction as gnsGetMyNamesAction } from './actions/get-my-names';
export { estimatePriceAction as gnsEstimatePriceAction } from './actions/estimate-price';
export { commitAction as gnsCommitAction } from './actions/commit';
export { waitForCommitmentAction as gnsWaitForCommitmentAction } from './actions/wait-for-commitment';
export { registerAction as gnsRegisterAction } from './actions/register';
export { renewAction as gnsRenewAction } from './actions/renew';
export { setProfileRecordsAction as gnsSetProfileRecordsAction } from './actions/set-profile-records';
export { setAddressAction as gnsSetAddressAction } from './actions/set-address';
export { setPrimaryNameAction as gnsSetPrimaryNameAction } from './actions/set-primary-name';
export { x402CreateOrderAction as gnsX402CreateOrderAction } from './actions/x402-create-order';
export { x402SubmitSignatureAction as gnsX402SubmitSignatureAction } from './actions/x402-submit-signature';
export { x402PayOrderAction as gnsX402PayOrderAction } from './actions/x402-pay-order';
export { x402GetOrderStatusAction as gnsX402GetOrderStatusAction } from './actions/x402-get-order-status';

// Action input/output type re-exports for callers
export type { CheckAvailabilityInput, CheckAvailabilityOutput } from './actions/check-availability';
export type { GetNameDetailsInput } from './actions/get-name-details';
export type { GetMyNamesInput } from './actions/get-my-names';
export type { EstimatePriceInput } from './actions/estimate-price';
export type { CommitInput, CommitOutput } from './actions/commit';
export type { WaitForCommitmentInput, WaitForCommitmentOutput } from './actions/wait-for-commitment';
export type { RegisterInput, RegisterOutput } from './actions/register';
export type { RenewInput, RenewOutput } from './actions/renew';
export type { SetProfileRecordsInput, SetProfileRecordsOutput } from './actions/set-profile-records';
export type { SetAddressInput, SetAddressOutput } from './actions/set-address';
export type { SetPrimaryNameInput, SetPrimaryNameOutput } from './actions/set-primary-name';
export type { X402CreateOrderInput } from './actions/x402-create-order';
export type {
  X402SubmitSignatureInput,
  X402SubmitSignatureOutput,
} from './actions/x402-submit-signature';
export type { X402PayOrderInput, X402PayOrderOutput } from './actions/x402-pay-order';
export type { X402GetOrderStatusInput } from './actions/x402-get-order-status';

// Adapter contract + concrete HTTP implementation
export type {
  GnsApiAdapter,
  SearchResponse,
  SearchResultItem,
  SearchStatus,
  NameDetailsResponse,
  NameDetailsRecord,
  NameLifecycle,
  QuoteInput,
  RegistrationQuoteResponse,
  MyNamesItem,
  MyNamesResponse,
  X402TokenConfig,
  X402ChainConfig,
  X402MerchantConfigResponse,
  CreateX402OrderInput,
  X402OrderResponse,
  X402OrderFlow,
  X402OrderLifecycle,
  X402OrderStatusResponse,
  X402SubmitSignatureResponse,
  CalldataSignRequest,
} from './adapters/types';
export { HttpGnsApiAdapter } from './adapters/http-gns-api';
export type { HttpGnsApiAdapterOptions, GnsNetworkKey as GnsApiNetworkKey } from './adapters/http-gns-api';

// Contracts (addresses + ABI fragments)
export {
  gnsContracts,
  getGnsContracts,
  REGISTRAR_CONTROLLER_ABI,
  PUBLIC_RESOLVER_ABI,
  REVERSE_REGISTRAR_ABI,
  ENS_REGISTRY_ABI,
  BASE_REGISTRAR_ABI,
  ERC20_ABI as GNS_ERC20_ABI,
  ERC20_PERMIT_ABI as GNS_ERC20_PERMIT_ABI,
} from './adapters/contracts';
export type { GnsContractRegistry, GnsNetworkKey } from './adapters/contracts';

// Constants
export {
  MIN_COMMITMENT_AGE_SEC,
  MAX_COMMITMENT_AGE_SEC,
  EXPIRY_SAFETY_MARGIN_SEC,
  READINESS_SUBMIT_BUFFER_SEC,
  YEAR_IN_SECONDS as GNS_YEAR_IN_SECONDS,
  LABEL_REGEX,
  NAME_REGEX,
  COIN_TYPES,
  ZERO_REFERRER,
  normalizeGoatName,
  assertValidName,
} from './constants';
export type { CoinTypeKey } from './constants';
