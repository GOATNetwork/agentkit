import { z } from 'zod';

/**
 * Shared Zod schema for OrderRecord.
 *
 * The Go backend's response (gift-api/internal/api/orders.go:504
 * `buildOrderResponse`) populates most fields unconditionally but a
 * handful are nullable / omitted depending on order state — we model
 * those with `.nullable().optional()` so an unfulfilled order
 * (`card === null`) and a fulfilled order (`card.card_code` set) both
 * pass validation. Unrecognised fields are kept via `.passthrough()`
 * so future backend additions are non-breaking.
 */

export const orderCardSchema = z
  .object({
    card_code: z.string().nullable().optional(),
    card_pin: z.string().nullable().optional(),
    card_link: z.string().nullable().optional(),
    card_barcode: z.string().nullable().optional(),
  })
  .passthrough();

export const orderRefundSchema = z
  .object({
    reason: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    tx_hash: z.string().nullable().optional(),
    amount_usd: z.number().nullable().optional(),
  })
  .passthrough();

export const orderRecordSchema = z
  .object({
    order_id: z.string(),
    status: z.string(),
    product_id: z.string(),
    card_brand_name: z.string(),
    country: z.string(),
    face_value: z.number(),
    face_value_local: z.number().nullable().optional(),
    currency_local: z.string().nullable().optional(),
    face_value_type: z.union([z.literal('FIXED'), z.literal('VARIABLE')]),
    sell_price_usd: z.number(),
    fx_rate_used: z.number().nullable().optional(),
    pay_amount_usd: z.number().optional(),
    pay_amount_wei: z.string().optional(),
    pay_chain_id: z.number().int(),
    pay_token_symbol: z.union([z.literal('USDC'), z.literal('USDT')]),
    pay_token_contract: z.string().optional(),
    pay_token_decimals: z.number().int().optional(),
    x402_order_id: z.string().nullable().optional(),
    pay_to_address: z.string().nullable().optional(),
    dapp_order_id: z.string().optional(),
    x402_tx_hash: z.string().nullable().optional(),
    paid_at: z.number().optional(),
    expire_at: z.number().optional(),
    created_at: z.number(),
    updated_at: z.number().optional(),
    card: orderCardSchema.nullable().optional(),
    refund: orderRefundSchema.nullable().optional(),
    // Flattened card secrets (action-layer convenience). See
    // plugins/giftcard/actions/get-order.ts.
    card_code: z.string().optional(),
    card_pin: z.string().optional(),
    card_link: z.string().optional(),
    card_barcode: z.string().optional(),
  })
  .passthrough();
