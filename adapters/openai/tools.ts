import type { ToolManifestItem } from '../../providers/tool-manifest';

export function toOpenAITools(manifest: ToolManifestItem[]) {
  return manifest.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema ?? { type: 'object', properties: {} },
    },
  }));
}
