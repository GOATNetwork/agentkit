import { z } from 'zod';
import type { ActionDefinition } from '../../../core/schema/action';
import type { WalletProvider } from '../../../core/wallet/wallet-provider';

export interface OftQuoteOftInput {
  oftAddress: string;
  dstEid: number;
  to: string;
  amountLD: string;
  minAmountLD: string;
  extraOptions: string;
  composeMsg: string;
  oftCmd: string;
}

export interface OftQuoteOftOutput {
  minAmountLD: string;
  maxAmountLD: string;
  amountSentLD: string;
  amountReceivedLD: string;
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
});

const QUOTE_OFT_ABI = [
  'function quoteOFT((uint32,bytes32,uint256,uint256,bytes,bytes,bytes)) view returns ((uint256,uint256),(uint256,uint256)[],(uint256,uint256))',
];

export function oftQuoteOftAction(
  wallet: WalletProvider,
): ActionDefinition<OftQuoteOftInput, OftQuoteOftOutput> {
  return {
    name: 'oft.quote_oft',
    description:
      'Get detailed OFT quote including transfer limits and fee breakdown for a LayerZero cross-chain transfer from Goat Network',
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
        QUOTE_OFT_ABI,
        'quoteOFT',
        [sendParam],
      )) as [[bigint, bigint], unknown[], [bigint, bigint]];
      const limit = result[0];
      const receipt = result[2];
      return {
        minAmountLD: String(limit[0]),
        maxAmountLD: String(limit[1]),
        amountSentLD: String(receipt[0]),
        amountReceivedLD: String(receipt[1]),
      };
    },
  };
}
