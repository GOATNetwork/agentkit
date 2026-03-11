import type { ToolManifestItem } from '../../providers/tool-manifest';

export function toVercelAITools(manifest: ToolManifestItem[]) {
  return manifest.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.inputSchema ?? { type: 'object', properties: {} },
  }));
}
