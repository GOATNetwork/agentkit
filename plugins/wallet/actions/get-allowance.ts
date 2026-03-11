import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { evmAddress } from '../../../core/schema/validators';

export interface GetAllowanceInput {
  tokenAddress: string;
  owner: string;
  spender: string;
}

export interface GetAllowanceOutput {
  tokenAddress: string;
  owner: string;
  spender: string;
  allowance: string;
}

const inputSchema = z.object({
  tokenAddress: evmAddress,
  owner: evmAddress,
  spender: evmAddress,
});

const ERC20_ALLOWANCE_ABI = ['function allowance(address owner, address spender) view returns (uint256)'];

export function getAllowanceAction(wallet: WalletProvider): ActionDefinition<GetAllowanceInput, GetAllowanceOutput> {
  return {
    name: 'wallet.get_allowance',
    description: 'Query ERC20 token allowance for a given owner and spender',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    async execute(_ctx, input) {
      const result = await wallet.callContract(
        input.tokenAddress,
        ERC20_ALLOWANCE_ABI,
        'allowance',
        [input.owner, input.spender],
      );
      return {
        tokenAddress: input.tokenAddress,
        owner: input.owner,
        spender: input.spender,
        allowance: String(result),
      };
    },
  };
}
