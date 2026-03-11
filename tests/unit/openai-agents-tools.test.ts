import { describe, it, expect } from 'vitest';
import { toOpenAIAgentsTools } from '../../adapters/openai-agents/tools';
import type { ToolManifestItem } from '../../providers/tool-manifest';

describe('toOpenAIAgentsTools', () => {
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

  it('maps manifest to OpenAI Agents SDK FunctionTool format', () => {
    const tools = toOpenAIAgentsTools(manifest);
    expect(tools).toHaveLength(2);

    expect(tools[0]).toEqual({
      name: 'test.action',
      description: 'A test action',
      params_json_schema: {
        type: 'object',
        properties: { x: { type: 'number' } },
        required: ['x'],
      },
    });
  });

  it('provides default empty schema when inputSchema is undefined', () => {
    const tools = toOpenAIAgentsTools(manifest);
    expect(tools[1].params_json_schema).toEqual({ type: 'object', properties: {} });
  });

  it('returns empty array for empty manifest', () => {
    expect(toOpenAIAgentsTools([])).toEqual([]);
  });
});
