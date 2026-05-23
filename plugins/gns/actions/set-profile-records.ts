import { z } from 'zod';
import { encodeFunctionData, labelhash, namehash } from 'viem';
import type { ActionDefinition } from '../../../core/schema/action';
import { AgentkitRuntimeError } from '../../../core/errors/error';
import { ErrorCodes } from '../../../core/errors/error-codes';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { ZERO_ADDRESS, assertValidName, normalizeGoatName } from '../constants';
import {
  BASE_REGISTRAR_ABI,
  ENS_REGISTRY_ABI,
  PUBLIC_RESOLVER_ABI,
  type GnsContractRegistry,
} from '../adapters/contracts';

const recordSchema = z.object({
  key: z.string().min(1),
  value: z.string(),
});

const inputSchema = z.object({
  name: z.string().min(1),
  records: z.array(recordSchema).min(1, 'at least one record is required'),
});

export type SetProfileRecordsInput = z.infer<typeof inputSchema>;

export interface SetProfileRecordsOutput {
  txHash: string;
  node: `0x${string}`;
  recordsCount: number;
}

const outputSchema: z.ZodType<SetProfileRecordsOutput> = z.object({
  txHash: z.string(),
  node: z.string().regex(/^0x[0-9a-fA-F]{64}$/) as z.ZodType<`0x${string}`>,
  recordsCount: z.number().int().nonnegative(),
});

/**
 * `goat.gns.setProfileRecords` — batch set text records via
 * `PublicResolver.multicallWithNodeCheck`.
 *
 * Preflight (per plan §B Codex #2): caller must be node owner OR approved
 * operator via `ensRegistry.isApprovedForAll(owner, caller)`. Without this
 * preflight the resolver will revert mid-multicall, wasting gas.
 */
export function setProfileRecordsAction(
  contracts: GnsContractRegistry,
  wallet: WalletProvider,
): ActionDefinition<SetProfileRecordsInput, SetProfileRecordsOutput> {
  // Build a viem-shape ABI for setText so encodeFunctionData can compose it.
  const setTextAbi = [
    {
      type: 'function',
      name: 'setText',
      stateMutability: 'nonpayable',
      inputs: [
        { name: 'node', type: 'bytes32' },
        { name: 'key', type: 'string' },
        { name: 'value', type: 'string' },
      ],
      outputs: [],
    },
  ] as const;

  return {
    name: 'goat.gns.setProfileRecords',
    description: 'Set one or more text (profile) records on a .goat name via PublicResolver multicall',
    riskLevel: 'medium',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    zodOutputSchema: outputSchema,
    async execute(ctx, input) {
      const { fullName, label } = normalizeGoatName(input.name);
      assertValidName(fullName);
      const node = namehash(fullName);
      const tokenId = BigInt(labelhash(label));
      const caller = await wallet.getAddress();

      // Authoritative ownership via the BaseRegistrar NFT (matches `renew`).
      const nftOwnerRaw = await wallet.callContract(
        contracts.baseRegistrar,
        BASE_REGISTRAR_ABI as unknown as string[],
        'ownerOf',
        [tokenId],
      );
      const nftOwner = String(nftOwnerRaw ?? ZERO_ADDRESS);
      if (nftOwner.toLowerCase() === ZERO_ADDRESS) {
        throw new AgentkitRuntimeError(
          ErrorCodes.POLICY_BLOCKED,
          `name has no on-chain owner; cannot set resolver records (name="${fullName}")`,
        );
      }
      const isOwner = nftOwner.toLowerCase() === caller.toLowerCase();
      let isOperator = false;
      if (!isOwner) {
        // ENS-registry operator delegation: resolver enforces this on-chain.
        const registryOwnerRaw = await wallet.callContract(
          contracts.ensRegistry,
          ENS_REGISTRY_ABI as unknown as string[],
          'owner',
          [node],
        );
        const registryOwner = String(registryOwnerRaw ?? ZERO_ADDRESS);
        if (registryOwner.toLowerCase() !== ZERO_ADDRESS) {
          const approvedRaw = await wallet.callContract(
            contracts.ensRegistry,
            ENS_REGISTRY_ABI as unknown as string[],
            'isApprovedForAll',
            [registryOwner, caller],
          );
          isOperator = Boolean(approvedRaw);
        }
      }
      if (!isOwner && !isOperator) {
        throw new AgentkitRuntimeError(
          ErrorCodes.POLICY_BLOCKED,
          `caller is neither owner nor approved operator for "${fullName}" (nftOwner=${nftOwner}, caller=${caller})`,
        );
      }

      const calls = input.records.map(({ key, value }) =>
        encodeFunctionData({ abi: setTextAbi, functionName: 'setText', args: [node, key, value] }),
      );

      const { txHash } = await wallet.writeContract(
        contracts.publicResolver,
        PUBLIC_RESOLVER_ABI as unknown as string[],
        'multicallWithNodeCheck',
        [node, calls],
        undefined,
        { signal: ctx.signal },
      );
      return { txHash, node, recordsCount: input.records.length };
    },
  };
}
