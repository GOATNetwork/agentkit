import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';

export interface OftSendInput {
  oftAddress: string;
  dstEid: number;
  to: string;
  amountLD: string;
  minAmountLD: string;
  extraOptions: string;
  composeMsg: string;
  oftCmd: string;
  nativeFee: string;
  lzTokenFee: string;
  refundAddress?: string;
}

export interface OftSendOutput {
  txHash: string;
}

const inputSchema = z.object({
  oftAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'oftAddress must be a valid address'),
  dstEid: z.number().int().positive('dstEid must be a positive integer'),
  to: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'to must be a bytes32 hex string'),
  amountLD: z.string().regex(/^\d+$/, 'amountLD must be a decimal integer string'),
  minAmountLD: z.string().regex(/^\d+$/, 'minAmountLD must be a decimal integer string'),
  extraOptions: z.string().startsWith('0x', 'extraOptions must be a hex string'),
  composeMsg: z.string().startsWith('0x', 'composeMsg must be a hex string'),
  oftCmd: z.string().startsWith('0x', 'oftCmd must be a hex string'),
  nativeFee: z.string().regex(/^\d+$/, 'nativeFee must be a decimal integer string'),
  lzTokenFee: z.string().regex(/^\d+$/, 'lzTokenFee must be a decimal integer string'),
  refundAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
});

const SEND_ABI = [
  'function send((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),(uint256,uint256),address) payable returns ((bytes32,uint64,uint256,uint256),(uint256,uint256))',
];

export function oftSendAction(
  wallet: WalletProvider,
): ActionDefinition<OftSendInput, OftSendOutput> {
  return {
    name: 'oft.send',
    description:
      'Execute a LayerZero OFT cross-chain token transfer from Goat Network to another chain',
    riskLevel: 'high',
    requiresConfirmation: true,
    networks: ['goat-mainnet'],
    zodInputSchema: inputSchema,
    async execute(ctx, input) {
      const refundAddress = input.refundAddress ?? (await wallet.getAddress());
      const sendParam = [
        input.dstEid,
        input.to,
        BigInt(input.amountLD),
        BigInt(input.minAmountLD),
        input.extraOptions,
        input.composeMsg,
        input.oftCmd,
      ];
      const fee = [BigInt(input.nativeFee), BigInt(input.lzTokenFee)];
      return wallet.writeContract(
        input.oftAddress,
        SEND_ABI,
        'send',
        [sendParam, fee, refundAddress],
        input.nativeFee,
        { signal: ctx.signal },
      );
    },
  };
}
