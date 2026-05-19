import { z } from 'zod';
import { encodeFunctionData, hexToBytes, isHex, namehash, toHex } from 'viem';
import type { ActionDefinition } from '../../../core/schema/action';
import { AgentkitRuntimeError } from '../../../core/errors/error';
import { ErrorCodes } from '../../../core/errors/error-codes';
import { evmAddress } from '../../../core/schema/validators';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';
import { ZERO_ADDRESS, assertValidName, normalizeGoatName } from '../constants';
import {
  ENS_REGISTRY_ABI,
  PUBLIC_RESOLVER_ABI,
  type GnsContractRegistry,
} from '../adapters/contracts';

const addressBindingSchema = z.object({
  coinType: z.number().int().nonnegative(),
  /**
   * Hex-encoded address bytes. For EVM coin types the bytes ARE the 20-byte
   * checksummed address. For BTC/SOL/etc. the bytes are the chain-specific
   * encoding (we do not transcode — the caller is responsible).
   */
  addressBytes: z.string().regex(/^0x[0-9a-fA-F]*$/),
});

const inputSchema = z
  .object({
    name: z.string().min(1),
    /** Convenience for the default ENS coin type 60 record. Mutually exclusive with `bindings`. */
    address: evmAddress.optional() as z.ZodOptional<z.ZodType<`0x${string}`>>,
    /** Chain-specific address bindings (ENSIP-11). */
    bindings: z.array(addressBindingSchema).optional(),
  })
  .refine((v) => Boolean(v.address || (v.bindings && v.bindings.length > 0)), {
    message: 'address or bindings is required',
    path: ['bindings'],
  });

export type SetAddressInput = z.infer<typeof inputSchema>;

export interface SetAddressOutput {
  txHash: string;
  node: `0x${string}`;
  bindingsCount: number;
}

const outputSchema: z.ZodType<SetAddressOutput> = z.object({
  txHash: z.string(),
  node: z.string().regex(/^0x[0-9a-fA-F]{64}$/) as z.ZodType<`0x${string}`>,
  bindingsCount: z.number().int().nonnegative(),
});

/**
 * `goat.gns.setAddress` — bind addresses to a .goat name via PublicResolver.
 *
 * Two record families:
 *   - Default EVM record: `setAddr(node, address)` (implicit coinType 60).
 *   - Chain-specific ENSIP-11 record: `setAddr(node, coinType, addressBytes)`.
 *
 * Preflight: same ownership/operator check as `setProfileRecords`.
 */
export function setAddressAction(
  contracts: GnsContractRegistry,
  wallet: WalletProvider,
): ActionDefinition<SetAddressInput, SetAddressOutput> {
  // viem-shape ABIs so encodeFunctionData picks the correct overload.
  const setAddrSingleAbi = [
    {
      type: 'function',
      name: 'setAddr',
      stateMutability: 'nonpayable',
      inputs: [
        { name: 'node', type: 'bytes32' },
        { name: '_addr', type: 'address' },
      ],
      outputs: [],
    },
  ] as const;
  const setAddrMulticoinAbi = [
    {
      type: 'function',
      name: 'setAddr',
      stateMutability: 'nonpayable',
      inputs: [
        { name: 'node', type: 'bytes32' },
        { name: 'coinType', type: 'uint256' },
        { name: 'addressBytes', type: 'bytes' },
      ],
      outputs: [],
    },
  ] as const;

  return {
    name: 'goat.gns.setAddress',
    description: 'Bind EVM or chain-specific address records to a .goat name',
    riskLevel: 'medium',
    requiresConfirmation: true,
    networks: ['goat-mainnet', 'goat-testnet'],
    zodInputSchema: inputSchema,
    zodOutputSchema: outputSchema,
    async execute(ctx, input) {
      const { fullName } = normalizeGoatName(input.name);
      assertValidName(fullName);
      const node = namehash(fullName);
      const caller = await wallet.getAddress();

      // Ownership / operator preflight (matches setProfileRecords).
      const ownerRaw = await wallet.callContract(
        contracts.ensRegistry,
        ENS_REGISTRY_ABI as unknown as string[],
        'owner',
        [node],
      );
      const owner = String(ownerRaw ?? ZERO_ADDRESS);
      if (owner === ZERO_ADDRESS) {
        throw new AgentkitRuntimeError(
          ErrorCodes.POLICY_BLOCKED,
          `name has no on-chain owner; cannot set address records (name="${fullName}")`,
        );
      }
      const isOwner = owner.toLowerCase() === caller.toLowerCase();
      let isOperator = false;
      if (!isOwner) {
        const approvedRaw = await wallet.callContract(
          contracts.ensRegistry,
          ENS_REGISTRY_ABI as unknown as string[],
          'isApprovedForAll',
          [owner, caller],
        );
        isOperator = Boolean(approvedRaw);
      }
      if (!isOwner && !isOperator) {
        throw new AgentkitRuntimeError(
          ErrorCodes.POLICY_BLOCKED,
          `caller is neither owner nor approved operator for "${fullName}"`,
        );
      }

      const calls: `0x${string}`[] = [];
      if (input.address) {
        calls.push(
          encodeFunctionData({
            abi: setAddrSingleAbi,
            functionName: 'setAddr',
            args: [node, input.address],
          }),
        );
      }
      if (input.bindings) {
        for (const b of input.bindings) {
          if (!isHex(b.addressBytes)) {
            throw new AgentkitRuntimeError(
              ErrorCodes.INVALID_INPUT,
              `binding addressBytes must be 0x-hex (coinType ${b.coinType})`,
            );
          }
          calls.push(
            encodeFunctionData({
              abi: setAddrMulticoinAbi,
              functionName: 'setAddr',
              args: [node, BigInt(b.coinType), toHex(hexToBytes(b.addressBytes as `0x${string}`))],
            }),
          );
        }
      }

      const { txHash } = await wallet.writeContract(
        contracts.publicResolver,
        PUBLIC_RESOLVER_ABI as unknown as string[],
        'multicallWithNodeCheck',
        [node, calls],
        undefined,
        { signal: ctx.signal },
      );
      return { txHash, node, bindingsCount: calls.length };
    },
  };
}
