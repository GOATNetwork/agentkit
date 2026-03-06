import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';

export interface DeployContractInput {
  abi: string[];
  bytecode: string;
  args?: unknown[];
  value?: string;
}

export interface DeployContractOutput {
  txHash: string;
  contractAddress: string;
}

const inputSchema = z.object({
  abi: z.array(z.string()),
  bytecode: z
    .string()
    .refine((v) => /^0x[0-9a-fA-F]+$/.test(v), { message: 'bytecode must be 0x-prefixed hex' }),
  args: z.array(z.unknown()).optional().default([]),
  value: z.string().optional(),
});

export function deployContractAction(
  wallet: WalletProvider,
): ActionDefinition<DeployContractInput, DeployContractOutput> {
  return {
    name: 'wallet.deploy_contract',
    description: 'Deploy a smart contract on-chain given its ABI and bytecode',
    riskLevel: 'high',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      return wallet.deployContract(input.abi, input.bytecode, input.args ?? [], input.value, { signal: ctx.signal });
    },
  };
}
