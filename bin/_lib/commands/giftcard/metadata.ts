import type { CliMetadata } from '../types';

export const GIFTCARD_CLI_METADATA: CliMetadata = {
  bin: 'agentkit-giftcard',
  summary: 'Buy and manage stablecoin-paid gift cards via the GOAT giftcard gateway',
  subcommands: [
    {
      name: 'regions',
      summary: 'Discover live giftcard regions',
      description: 'Probes the brand catalog and lists the country codes that currently have brands (e.g. US, CA).',
      actions: ['goat.giftcard.listBrands'],
      risk: 'read',
    },
    {
      name: 'list-brands',
      summary: 'List giftcard brands',
      description:
        'Browse giftcard brands filtered by country / category / language. A region is required (run `regions` to discover them).',
      flags: [
        {
          flag: '--country <iso2>',
          description: 'ISO 3166-1 alpha-2 country (e.g. US, CA); required when non-interactive',
        },
        { flag: '--category <id>', description: 'Category id (e.g. shopping)' },
        { flag: '--lang <bcp47>', description: 'BCP-47 language (e.g. en, en-US)' },
      ],
      actions: ['goat.giftcard.listBrands'],
      risk: 'read',
    },
    {
      name: 'get-brand',
      summary: 'Read full details for a single brand',
      description: 'Returns brand metadata + products (face value range, currency, markup).',
      args: [{ name: '<brand-id>', description: 'Brand UUID' }],
      flags: [{ flag: '--lang <bcp47>', description: 'BCP-47 language', defaultValue: 'en' }],
      actions: ['goat.giftcard.getBrand'],
      risk: 'read',
    },
    {
      name: 'list-chains',
      summary: 'List supported payment chains + tokens',
      description: 'Returns the chains + ERC-20 contracts the gateway accepts.',
      actions: ['goat.giftcard.listSupportedTokens'],
      risk: 'read',
    },
    {
      name: 'buy',
      summary: 'Buy a giftcard (createOrder → payOrder → poll until FULFILLED)',
      description:
        'Drives the full purchase: creates an order, executes the ERC-20 transfer on the chosen chain, and polls until FULFILLED. Card secrets are redacted in hook events.',
      flags: [
        { flag: '--brand <id>', description: 'Brand UUID' },
        { flag: '--product <id>', description: 'Product UUID (skips brand lookup)' },
        { flag: '--face-value <amount>', description: "Face value in the brand's local currency", defaultValue: 50 },
        {
          flag: '--pay-chain <chainId>',
          description: 'Payment chain id (default: GOAT 2345; omit to pick interactively)',
          defaultValue: 2345,
        },
        { flag: '--pay-token <symbol>', description: 'Payment token symbol (USDC or USDT)', defaultValue: 'USDC' },
        { flag: '--poll-timeout-sec <n>', description: 'Max seconds to poll for fulfillment', defaultValue: 60 },
      ],
      actions: [
        'goat.giftcard.getBrand',
        'goat.giftcard.createOrder',
        'goat.giftcard.payOrder',
        'goat.giftcard.getOrder',
      ],
      risk: 'high',
    },
    {
      name: 'status',
      summary: 'Read a single order',
      description: 'Returns the latest order record. Card secrets are redacted unless --reveal-secrets is set.',
      args: [{ name: '<order-id>', description: 'Order UUID' }],
      actions: ['goat.giftcard.getOrder'],
      risk: 'read',
    },
    {
      name: 'list-orders',
      summary: "List the authenticated wallet's orders",
      description: 'Optionally filter by status. Pagination via --limit / --offset.',
      flags: [
        { flag: '--status <status>', description: 'Filter by order status' },
        { flag: '--limit <n>', description: 'Page size (1..200)', defaultValue: 50 },
        { flag: '--offset <n>', description: 'Pagination offset', defaultValue: 0 },
      ],
      actions: ['goat.giftcard.listOrders'],
      risk: 'read',
    },
    {
      name: 'doctor',
      summary: 'Diagnose env vars, API connectivity, and wallet config',
      description: 'Read-only sanity check. Exits 0 on success, 1 if any check fails.',
      actions: [],
      risk: 'read',
    },
  ],
};
