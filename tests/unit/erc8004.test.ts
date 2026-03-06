import { describe, it, expect, vi } from 'vitest';
import {
  erc8004RegisterAgentAction,
  erc8004SetAgentURIAction,
  erc8004GetMetadataAction,
  erc8004SetMetadataAction,
  erc8004GetAgentWalletAction,
  erc8004GiveFeedbackAction,
  erc8004RevokeFeedbackAction,
  erc8004GetReputationAction,
  erc8004GetClientsAction,
  IDENTITY_REGISTRY_ADDRESS,
  REPUTATION_REGISTRY_ADDRESS,
} from '../../plugins/erc8004/index';
import type { WalletProvider } from '../../core/wallet/wallet-provider';

function mockWallet(overrides: Partial<WalletProvider> = {}): WalletProvider {
  return {
    getAddress: vi.fn().mockResolvedValue('0xABCD'),
    getNetwork: vi.fn().mockResolvedValue('goat-mainnet'),
    getBalance: vi.fn().mockResolvedValue('1000'),
    getErc20Balance: vi.fn().mockResolvedValue('500'),
    transferNative: vi.fn().mockResolvedValue({ txHash: '0xtx' }),
    transferErc20: vi.fn().mockResolvedValue({ txHash: '0xtx' }),
    approveErc20: vi.fn().mockResolvedValue({ txHash: '0xtx' }),
    signTypedData: vi.fn().mockResolvedValue('0xsig'),
    callContract: vi.fn().mockResolvedValue('0x'),
    writeContract: vi.fn().mockResolvedValue({ txHash: '0xtx_8004' }),
    deployContract: vi.fn().mockResolvedValue({ txHash: '0xtx_deploy', contractAddress: '0xNEW' }),
    ...overrides,
  };
}

const ctx = { traceId: 't1', network: 'goat-mainnet', now: Date.now() };

describe('erc8004.register_agent', () => {
  it('has correct metadata', () => {
    const wallet = mockWallet();
    const action = erc8004RegisterAgentAction(wallet);
    expect(action.name).toBe('erc8004.register_agent');
    expect(action.riskLevel).toBe('high');
    expect(action.requiresConfirmation).toBe(true);
  });

  it('calls writeContract on Identity Registry with register', async () => {
    const wallet = mockWallet();
    const action = erc8004RegisterAgentAction(wallet);
    const result = await action.execute(ctx, { agentURI: 'https://example.com/agent.json' });
    expect(result).toEqual({ txHash: '0xtx_8004' });
    expect(wallet.writeContract).toHaveBeenCalledWith(
      IDENTITY_REGISTRY_ADDRESS,
      ['function register(string agentURI) returns (uint256 agentId)'],
      'register',
      ['https://example.com/agent.json'],
      undefined,
      { signal: undefined },
    );
  });
});

describe('erc8004.set_agent_uri', () => {
  it('calls writeContract with setAgentURI', async () => {
    const wallet = mockWallet();
    const action = erc8004SetAgentURIAction(wallet);
    expect(action.name).toBe('erc8004.set_agent_uri');
    expect(action.riskLevel).toBe('medium');

    const result = await action.execute(ctx, { agentId: '42', newURI: 'https://new.uri/agent.json' });
    expect(result).toEqual({ txHash: '0xtx_8004' });
    expect(wallet.writeContract).toHaveBeenCalledWith(
      IDENTITY_REGISTRY_ADDRESS,
      expect.any(Array),
      'setAgentURI',
      [BigInt(42), 'https://new.uri/agent.json'],
      undefined,
      { signal: undefined },
    );
  });
});

describe('erc8004.get_metadata', () => {
  it('calls callContract with getMetadata', async () => {
    const wallet = mockWallet({ callContract: vi.fn().mockResolvedValue('0xdeadbeef') });
    const action = erc8004GetMetadataAction(wallet);
    expect(action.name).toBe('erc8004.get_metadata');
    expect(action.riskLevel).toBe('read');

    const result = await action.execute(ctx, { agentId: '1', metadataKey: 'description' });
    expect(result).toEqual({ agentId: '1', metadataKey: 'description', metadataValue: '0xdeadbeef' });
    expect(wallet.callContract).toHaveBeenCalledWith(
      IDENTITY_REGISTRY_ADDRESS,
      expect.any(Array),
      'getMetadata',
      [BigInt(1), 'description'],
    );
  });
});

describe('erc8004.set_metadata', () => {
  it('calls writeContract with setMetadata', async () => {
    const wallet = mockWallet();
    const action = erc8004SetMetadataAction(wallet);
    expect(action.name).toBe('erc8004.set_metadata');
    expect(action.riskLevel).toBe('medium');

    await action.execute(ctx, { agentId: '1', metadataKey: 'description', metadataValue: '0x1234' });
    expect(wallet.writeContract).toHaveBeenCalledWith(
      IDENTITY_REGISTRY_ADDRESS,
      expect.any(Array),
      'setMetadata',
      [BigInt(1), 'description', '0x1234'],
      undefined,
      { signal: undefined },
    );
  });
});

describe('erc8004.get_agent_wallet', () => {
  it('calls callContract with getAgentWallet', async () => {
    const wallet = mockWallet({ callContract: vi.fn().mockResolvedValue('0xWALLET') });
    const action = erc8004GetAgentWalletAction(wallet);
    expect(action.name).toBe('erc8004.get_agent_wallet');
    expect(action.riskLevel).toBe('read');

    const result = await action.execute(ctx, { agentId: '5' });
    expect(result).toEqual({ agentId: '5', wallet: '0xWALLET' });
  });
});

describe('erc8004.give_feedback', () => {
  it('calls writeContract on Reputation Registry with giveFeedback', async () => {
    const wallet = mockWallet();
    const action = erc8004GiveFeedbackAction(wallet);
    expect(action.name).toBe('erc8004.give_feedback');
    expect(action.riskLevel).toBe('medium');
    expect(action.requiresConfirmation).toBe(true);

    const hash = '0x' + 'ab'.repeat(32);
    const result = await action.execute(ctx, {
      agentId: '1',
      value: 87,
      valueDecimals: 0,
      tag1: 'quality',
      tag2: '',
      endpoint: 'https://agent.example.com',
      feedbackURI: 'ipfs://feedback',
      feedbackHash: hash,
    });
    expect(result).toEqual({ txHash: '0xtx_8004' });
    expect(wallet.writeContract).toHaveBeenCalledWith(
      REPUTATION_REGISTRY_ADDRESS,
      expect.any(Array),
      'giveFeedback',
      [BigInt(1), 87, 0, 'quality', '', 'https://agent.example.com', 'ipfs://feedback', hash],
      undefined,
      { signal: undefined },
    );
  });
});

describe('erc8004.revoke_feedback', () => {
  it('calls writeContract with revokeFeedback', async () => {
    const wallet = mockWallet();
    const action = erc8004RevokeFeedbackAction(wallet);
    expect(action.name).toBe('erc8004.revoke_feedback');

    await action.execute(ctx, { agentId: '1', feedbackIndex: '3' });
    expect(wallet.writeContract).toHaveBeenCalledWith(
      REPUTATION_REGISTRY_ADDRESS,
      expect.any(Array),
      'revokeFeedback',
      [BigInt(1), BigInt(3)],
      undefined,
      { signal: undefined },
    );
  });
});

describe('erc8004.get_reputation', () => {
  it('calls callContract with getSummary and parses result', async () => {
    const mockResult = [BigInt(10), BigInt(850), 1];
    const wallet = mockWallet({ callContract: vi.fn().mockResolvedValue(mockResult) });
    const action = erc8004GetReputationAction(wallet);
    expect(action.name).toBe('erc8004.get_reputation');
    expect(action.riskLevel).toBe('read');

    const result = await action.execute(ctx, {
      agentId: '1',
      clientAddresses: [],
      tag1: 'quality',
      tag2: '',
    });
    expect(result).toEqual({
      agentId: '1',
      count: '10',
      summaryValue: '850',
      summaryValueDecimals: 1,
    });
  });
});

describe('erc8004.get_clients', () => {
  it('calls callContract with getClients', async () => {
    const clients = ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222'];
    const wallet = mockWallet({ callContract: vi.fn().mockResolvedValue(clients) });
    const action = erc8004GetClientsAction(wallet);
    expect(action.name).toBe('erc8004.get_clients');
    expect(action.riskLevel).toBe('read');

    const result = await action.execute(ctx, { agentId: '1' });
    expect(result).toEqual({ agentId: '1', clients });
  });
});
