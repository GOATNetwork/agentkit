import { describe, it, expect } from 'vitest';
import { toVercelAITools } from '../../adapters/vercel-ai/tools';
import type { ToolManifestItem } from '../../providers/tool-manifest';

describe('toVercelAITools', () => {
  const manifest: ToolManifestItem[] = [
    {
      name: 'test.action',
      description: 'A test action',
      riskLevel: 'low',
      requiresConfirmation: false,
      networks: ['goat-testnet'],
      inputSchema: {
        type: 'object',
        properties: { x: { type: 'number' } },
        required: ['x'],
      },
    },
    {
      name: 'test.read',
      description: 'A read action',
      riskLevel: 'read',
      requiresConfirmation: false,
      networks: [],
    },
  ];

  it('maps manifest to Vercel AI SDK tool format', () => {
    const tools = toVercelAITools(manifest);
    expect(tools).toHaveLength(2);

    expect(tools[0]).toEqual({
      name: 'test.action',
      description: 'A test action',
      parameters: {
        type: 'object',
        properties: { x: { type: 'number' } },
        required: ['x'],
      },
    });
  });

  it('provides default empty schema when inputSchema is undefined', () => {
    const tools = toVercelAITools(manifest);
    expect(tools[1].parameters).toEqual({ type: 'object', properties: {} });
  });

  it('returns empty array for empty manifest', () => {
    expect(toVercelAITools([])).toEqual([]);
  });
});
