// Legacy bridge actions (GoatAdapter-based)
export { bridgeDepositAction } from './actions/bridge.deposit';
export { bridgeWithdrawAction } from './actions/bridge.withdraw';
export { bridgeStatusAction } from './actions/bridge.status';

// On-chain staking flow (WalletProvider-based)
export {
  bitvm2RegisterPubkeyAction,
  GATEWAY_ADDRESS,
  STAKE_MANAGEMENT_ADDRESS,
  PEGBTC_ADDRESS,
} from './actions/stake.register-pubkey';
export { bitvm2StakeApproveAction } from './actions/stake.approve';
export { bitvm2StakeAction } from './actions/stake.stake';
export { bitvm2LockStakeAction } from './actions/stake.lock';
export { bitvm2PegBtcBalanceAction } from './actions/pegbtc.balance';

// Peg-in / Peg-out flow (GoatAdapter-based)
export { bitvm2PeginRequestAction } from './actions/pegin.request';
export { bitvm2PegoutInitiateAction } from './actions/pegout.initiate';
