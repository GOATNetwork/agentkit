import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { BRIDGE_ADDRESS } from './withdraw';

export interface BridgeDepositStatusInput {
  txHash: string;
  txout: number;
}

export interface BridgeDepositStatusOutput {
  txHash: string;
  txout: number;
  deposited: boolean;
}

const inputSchema = z.object({
  txHash: z.string().min(1, 'txHash must be a Bitcoin transaction hash'),
  txout: z.number().int().min(0, 'txout must be a non-negative integer'),
});

const IS_DEPOSITED_ABI = ['function isDeposited(bytes32,uint32) view returns (bool)'];

export function bridgeDepositStatusAction(
  wallet: WalletProvider,
): ActionDefinition<BridgeDepositStatusInput, BridgeDepositStatusOutput> {
  return {
    name: 'bridge.deposit_status',
    description: 'Check whether a Bitcoin deposit has been credited on Goat Network',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(_ctx, input) {
      const deposited = await wallet.callContract(
        BRIDGE_ADDRESS,
        IS_DEPOSITED_ABI,
        'isDeposited',
        [input.txHash, input.txout],
      );
      return { txHash: input.txHash, txout: input.txout, deposited: Boolean(deposited) };
    },
  };
}
