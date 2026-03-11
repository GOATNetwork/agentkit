import type { ToolManifestItem } from '../../providers/tool-manifest';

export function toMcpTools(manifest: ToolManifestItem[]) {
  return manifest.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
  }));
}
