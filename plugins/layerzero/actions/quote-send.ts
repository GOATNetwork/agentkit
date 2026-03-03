import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';

export interface OftQuoteSendInput {
  oftAddress: string;
  dstEid: number;
  to: string;
  amountLD: string;
  minAmountLD: string;
  extraOptions: string;
  composeMsg: string;
  oftCmd: string;
  payInLzToken: boolean;
}

export interface OftQuoteSendOutput {
  nativeFee: string;
  lzTokenFee: string;
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
  payInLzToken: z.boolean(),
});

const QUOTE_SEND_ABI = [
  'function quoteSend((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),bool) view returns (uint256,uint256)',
];

export function oftQuoteSendAction(
  wallet: WalletProvider,
): ActionDefinition<OftQuoteSendInput, OftQuoteSendOutput> {
  return {
    name: 'oft.quote_send',
    description:
      'Estimate the messaging fee for a LayerZero OFT cross-chain token transfer from Goat Network',
    riskLevel: 'read',
    requiresConfirmation: false,
    networks: ['goat-mainnet'],
    zodInputSchema: inputSchema,
    async execute(_ctx, input) {
      const sendParam = [
        input.dstEid,
        input.to,
        BigInt(input.amountLD),
        BigInt(input.minAmountLD),
        input.extraOptions,
        input.composeMsg,
        input.oftCmd,
      ];
      const result = (await wallet.callContract(
        input.oftAddress,
        QUOTE_SEND_ABI,
        'quoteSend',
        [sendParam, input.payInLzToken],
      )) as [bigint, bigint];
      return {
        nativeFee: String(result[0]),
        lzTokenFee: String(result[1]),
      };
    },
  };
}
