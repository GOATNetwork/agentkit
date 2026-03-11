import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { BRIDGE_ADDRESS } from './withdraw';

export interface BridgeGetParamsOutput {
  depositParam: unknown;
  withdrawParam: unknown;
}

const inputSchema = z.object({});

const DEPOSIT_PARAM_ABI = ['function depositParam() view returns (uint64,uint64)'];
const WITHDRAW_PARAM_ABI = [
  'function withdrawParam() view returns (uint64,uint64,uint16,uint16,uint16)',
];

export function bridgeGetParamsAction(
  wallet: WalletProvider,
): ActionDefinition<Record<string, never>, BridgeGetParamsOutput> {
  return {
    name: 'bridge.get_params',
    description: 'Get the current deposit and withdrawal parameters from the Bridge contract',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(_ctx, _input) {
      const [depositParam, withdrawParam] = await Promise.all([
        wallet.callContract(BRIDGE_ADDRESS, DEPOSIT_PARAM_ABI, 'depositParam', []),
        wallet.callContract(BRIDGE_ADDRESS, WITHDRAW_PARAM_ABI, 'withdrawParam', []),
      ]);
      return { depositParam, withdrawParam };
    },
  };
}
