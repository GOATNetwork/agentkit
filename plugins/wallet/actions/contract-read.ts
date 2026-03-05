import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { evmAddress } from '../../../core/schema/validators';

export interface ContractReadInput {
  contractAddress: string;
  abi: string[];
  functionName: string;
  args: unknown[];
}

export interface ContractReadOutput {
  result: unknown;
}

const inputSchema = z.object({
  contractAddress: evmAddress,
  abi: z.array(z.string()),
  functionName: z.string().min(1),
  args: z.array(z.unknown()).default([]),
});

export function contractReadAction(wallet: WalletProvider): ActionDefinition<ContractReadInput, ContractReadOutput> {
  return {
    name: 'wallet.contract_read',
    description: 'Read data from a smart contract (view/pure function call)',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(_ctx, input) {
      const result = await wallet.callContract(input.contractAddress, input.abi, input.functionName, input.args);
      return { result };
    },
  };
}
