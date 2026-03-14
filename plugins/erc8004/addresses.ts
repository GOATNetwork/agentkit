/**
 * ERC-8004 contract addresses per network.
 *
 * Mainnet contracts are CREATE2-deployed at deterministic 0x8004… addresses.
 * Testnet3 contracts are deployed at different addresses and may not all be available yet.
 */

export interface Erc8004Addresses {
  identityRegistry: string;
  reputationRegistry: string | null; // null = not deployed on this network
}

const addresses: Record<string, Erc8004Addresses> = {
  'goat-mainnet': {
    identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    reputationRegistry: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
  },
  'goat-testnet': {
    identityRegistry: '0x556089008Fc0a60cD09390Eca93477ca254A5522',
    reputationRegistry: '0xd9140951d8aE6E5F625a02F5908535e16e3af964',
  },
};

export function getIdentityRegistryAddress(network: string): string {
  const entry = addresses[network];
  if (!entry) {
    throw new Error(`ERC-8004 Identity Registry is not available on network "${network}"`);
  }
  return entry.identityRegistry;
}

export function getReputationRegistryAddress(network: string): string {
  const entry = addresses[network];
  if (!entry || entry.reputationRegistry === null) {
    throw new Error(`ERC-8004 Reputation Registry is not deployed on network "${network}"`);
  }
  return entry.reputationRegistry;
}
