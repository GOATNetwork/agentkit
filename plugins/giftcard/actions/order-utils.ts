import type { OrderRecord } from '../adapters/types';

/**
 * Card-secret field names the runtime's shallow-with-array-hop redactor
 * must redact in giftcard action outputs. Exported as a single source of
 * truth so every action that returns an `OrderRecord` declares the same
 * `sensitiveOutputFields` list.
 *
 * The list intentionally covers ONLY top-level field names. The action
 * output shape is normalised by `flattenCardFields` below, which drops
 * the nested `card` object and promotes its members to the top level —
 * without that step a nested `card.card_code` would slip past the
 * shallow redactor and leak into onActionSuccess hook events.
 */
export const ORDER_SENSITIVE_FIELDS = [
  'card_code',
  'card_pin',
  'card_link',
  'card_barcode',
] as const;

/**
 * Promote the four `card.{card_code,card_pin,card_link,card_barcode}`
 * members of the backend response to the top level and DROP the nested
 * `card` object.
 *
 * Why drop, not preserve: the runtime's `redactFields` only redacts
 * top-level keys (with a one-hop walk into top-level arrays of
 * records). Keeping the nested `card` alongside the flattened copy
 * would mean every hook event contains a plaintext duplicate of every
 * delivered card code. The action's caller-visible `result.output`
 * still carries the secrets at the top level; only the on-hook /
 * on-log view loses the nested duplicate.
 */
export function flattenCardFields(order: OrderRecord): OrderRecord {
  const card = order.card;
  if (!card) {
    const { card: _drop, ...rest } = order;
    void _drop;
    return rest as OrderRecord;
  }
  const { card: _drop, ...rest } = order;
  void _drop;
  // Fall back to the existing top-level value when the nested counterpart
  // is null/undefined, instead of unconditionally clobbering with
  // `undefined`. Some backend shapes (and SDK-shaped replays) populate
  // top-level card_* directly with the nested field absent or null —
  // without this fallback the flatten erases delivered secrets and the
  // operator sees no card data.
  const r = rest as Record<string, unknown>;
  return {
    ...rest,
    card_code: card.card_code ?? (r.card_code as string | undefined),
    card_pin: card.card_pin ?? (r.card_pin as string | undefined),
    card_link: card.card_link ?? (r.card_link as string | undefined),
    card_barcode: card.card_barcode ?? (r.card_barcode as string | undefined),
  } as OrderRecord;
}
