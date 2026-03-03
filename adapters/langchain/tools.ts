import type { ToolManifestItem } from '../../providers/tool-manifest';

export function toLangChainToolDefs(manifest: ToolManifestItem[]) {
  return manifest.map((t) => ({
    name: t.name,
    description: t.description,
    schema: t.inputSchema ?? { type: 'object', properties: {} },
  }));
}
