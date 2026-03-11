import type { ActionDefinition } from '../core/schema/action';
import { toLangChainToolDefs } from '../adapters/langchain/tools';
import { toOpenAITools } from '../adapters/openai/tools';
import { toMcpTools } from '../adapters/mcp/tools';
import { toVercelAITools } from '../adapters/vercel-ai/tools';
import { toOpenAIAgentsTools } from '../adapters/openai-agents/tools';
import { buildToolManifest } from './tool-manifest';

export class ActionProvider {
  private readonly actions = new Map<string, ActionDefinition>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register(action: ActionDefinition<any, any>): void {
    if (this.actions.has(action.name)) {
      throw new Error(`Action already exists: ${action.name}`);
    }
    this.actions.set(action.name, action);
  }

  get(name: string): ActionDefinition {
    const action = this.actions.get(name);
    if (!action) throw new Error(`Action not found: ${name}`);
    return action;
  }

  list(): ActionDefinition[] {
    return Array.from(this.actions.values());
  }

  listForNetwork(network: string): ActionDefinition[] {
    return this.list().filter(
      (a) => a.networks.length === 0 || a.networks.includes(network),
    );
  }

  manifest(network?: string) {
    const actions = network ? this.listForNetwork(network) : this.list();
    return buildToolManifest(actions);
  }

  openAITools(network?: string) {
    return toOpenAITools(this.manifest(network));
  }

  langChainToolDefs(network?: string) {
    return toLangChainToolDefs(this.manifest(network));
  }

  mcpTools(network?: string) {
    return toMcpTools(this.manifest(network));
  }

  vercelAITools(network?: string) {
    return toVercelAITools(this.manifest(network));
  }

  openAIAgentsTools(network?: string) {
    return toOpenAIAgentsTools(this.manifest(network));
  }
}
