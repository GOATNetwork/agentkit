import { toWei, type QuickPayManifest } from 'goatflow-paykit';
import { AgentkitRuntimeError } from '../../core/errors/error';
import { ErrorCodes } from '../../core/errors/error-codes';
import { evmAddressPattern, invalid, invalidResponse } from './http';
import type { CardCheckoutInput, PaykitPaymentInput } from './service';

function productKey(value: string): void {
  if (!/^[A-Za-z0-9._:~-]{1,64}$/.test(value) || value === '.' || value === '..') invalid('Invalid productKey');
}

function memo(value: string | undefined, required?: boolean): void {
  if (required && !value?.trim()) invalid('This merchant requires a memo');
  if (Buffer.byteLength(value ?? '', 'utf8') > 256) invalid('Memo is too long (max 256 bytes)');
}

function amountWei(amount: string, decimals: number): bigint {
  try {
    const value = BigInt(toWei(amount, decimals));
    if (value <= 0n || value >= 2n ** 256n) invalid('Amount must be positive and fit uint256');
    return value;
  } catch (error) {
    if (error instanceof AgentkitRuntimeError) throw error;
    // Never echo a manifest price/currency or an SDK/network error body.
    throw new AgentkitRuntimeError(
      ErrorCodes.INVALID_INPUT,
      'Amount must be a decimal string within the selected currency precision',
      error,
    );
  }
}

/** Fresh-intent validation. Recovery reads its persisted terms instead of today's catalog. */
export function preflightX402(input: PaykitPaymentInput, manifest: QuickPayManifest): void {
  const rail = manifest.rails.x402;
  if (!rail.enabled) invalid('x402 payments are not available for this merchant');
  const symbol = input.tokenSymbol?.trim();
  const contract = input.tokenContract?.trim();
  if (!symbol && !contract) invalid('Provide tokenSymbol or tokenContract');
  const tokens = rail.tokens.filter(
    (t) =>
      t.chain_id === input.chainId &&
      (!symbol || t.token_symbol.toUpperCase() === symbol.toUpperCase()) &&
      (!contract || t.token_contract.toLowerCase() === contract.toLowerCase()),
  );
  if (!tokens.length) invalid('Selected token is not supported by this merchant on this chain');
  if (tokens.length !== 1) invalid('Selected token is ambiguous; provide tokenContract');
  const token = tokens[0]!;
  if (!evmAddressPattern.test(token.token_contract)) invalidResponse('Manifest token address is invalid');
  let amount = input.amount!;
  if (input.productKey) {
    productKey(input.productKey);
    if (input.memo) invalid('Product payments do not accept a memo');
    const product = rail.products?.find((p) => p.product_key === input.productKey);
    if (!product) invalid('Product is not offered by this merchant');
    amount = product.price;
  } else {
    if (rail.custom_amount === false) invalid('Custom-amount x402 payments are not available');
    memo(input.memo, rail.memo_required);
  }
  const value = amountWei(amount, token.decimals);
  if (value < BigInt(token.min_amount_wei)) invalid('Amount is below the merchant minimum');
  if (token.max_amount_wei && value > BigInt(token.max_amount_wei)) invalid('Amount exceeds the merchant maximum');
}

export function preflightCard(input: CardCheckoutInput, manifest: QuickPayManifest): void {
  const rail = manifest.rails.fiat;
  if (!rail?.enabled) invalid('Card checkout is not available for this merchant');
  if (!rail.human_action_required || !rail.currency || rail.minor_unit_exponent === undefined)
    invalidResponse('Card checkout manifest is missing valid currency or human-payment terms');
  const product = input.productKey?.trim();
  const amount = input.amount?.trim();
  if (!!product === !!amount) invalid('Provide exactly one of amount or productKey');
  if (product) {
    productKey(product);
    if (input.memo?.trim()) invalid('Product card checkout does not accept a memo');
    if (!rail.products?.some((p) => p.product_key === product)) invalid('Product is not available on the card rail');
  } else {
    if (rail.custom_amount === false) invalid('Custom-amount card checkout is not available');
    if (!/^\d{1,40}(?:\.\d+)?$/.test(amount!)) invalid('Card amount must be a positive decimal string');
    amountWei(amount!, rail.minor_unit_exponent);
    memo(input.memo?.trim(), rail.memo_required);
  }
}
