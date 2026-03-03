import type { ToolManifestItem } from '../../providers/tool-manifest';

export interface OpenAIAgentsTool {
  name: string;
  description: string;
  params_json_schema: Record<string, unknown>;
}

export function toOpenAIAgentsTools(manifest: ToolManifestItem[]): OpenAIAgentsTool[] {
  return manifest.map((t) => ({
    name: t.name,
    description: t.description,
    params_json_schema: t.inputSchema ?? { type: 'object', properties: {} },
  }));
}
