import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';

export interface ContractWriteInput {
  contractAddress: string;
  abi: string[];
  functionName: string;
  args: unknown[];
}

export interface ContractWriteOutput {
  txHash: string;
}

const inputSchema = z.object({
  contractAddress: z.string().min(4),
  abi: z.array(z.string()),
  functionName: z.string().min(1),
  args: z.array(z.unknown()).default([]),
});

export function contractWriteAction(wallet: WalletProvider): ActionDefinition<ContractWriteInput, ContractWriteOutput> {
  return {
    name: 'wallet.contract_write',
    description: 'Write to a smart contract (state-changing function call)',
    riskLevel: 'high',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(_ctx, input) {
      return wallet.writeContract(input.contractAddress, input.abi, input.functionName, input.args);
    },
  };
}
