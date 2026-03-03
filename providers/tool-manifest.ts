import type { ActionDefinition } from '../core/schema/action';
import { zodToJsonSchema } from 'zod-to-json-schema';

export interface ToolManifestItem {
  name: string;
  description: string;
  riskLevel: string;
  requiresConfirmation: boolean;
  networks: string[];
  inputSchema?: Record<string, unknown>;
}

function deriveInputSchema(action: ActionDefinition): Record<string, unknown> | undefined {
  if (action.inputSchema) return action.inputSchema;
  if (action.zodInputSchema) {
    const json = zodToJsonSchema(action.zodInputSchema, {
      name: `${action.name.replace(/[^a-zA-Z0-9_]/g, '_')}_input`,
      $refStrategy: 'none',
    }) as Record<string, unknown>;

    if (json.definitions && typeof json.definitions === 'object') {
      const first = Object.values(json.definitions)[0];
      if (first && typeof first === 'object') return first as Record<string, unknown>;
    }
    return json;
  }
  return undefined;
}

export function buildToolManifest(actions: ActionDefinition[]): ToolManifestItem[] {
  return actions.map((a) => ({
    name: a.name,
    description: a.description,
    riskLevel: a.riskLevel,
    requiresConfirmation: a.requiresConfirmation,
    networks: a.networks,
    inputSchema: deriveInputSchema(a),
  }));
}
