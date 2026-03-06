import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { evmAddress } from '../../../core/schema/validators';

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
  contractAddress: evmAddress,
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
    async execute(ctx, input) {
      return wallet.writeContract(input.contractAddress, input.abi, input.functionName, input.args, undefined, { signal: ctx.signal });
    },
  };
}
