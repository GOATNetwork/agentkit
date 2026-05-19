/**
 * Structured metadata used by both:
 *
 *   1. The CLI itself — to build commander `--help` text from a single
 *      source of truth.
 *   2. The Phase H skill bundles' `manifest.json.scripts[]` entries —
 *      via the `scripts/sync-skill-manifests.mjs` codegen.
 *
 * Keep this shape stable; tightening it will require regenerating the
 * manifest stubs and updating consumers in PR #5.
 */
export interface CommandFlag {
  /** The `--name <value>` or `--bool` flag spec passed to commander. */
  flag: string;
  /** Help text shown next to the flag. */
  description: string;
  /** Optional default value. */
  defaultValue?: string | number | boolean;
}

export interface CommandArg {
  /** Positional name (e.g. `<name>` or `[orderId]`). */
  name: string;
  description: string;
}

export interface SubcommandMetadata {
  /** Subcommand verb (e.g. `lookup`, `register`, `buy`). */
  name: string;
  /** One-line summary for help text + manifest. */
  summary: string;
  /** Long description (markdown ok). */
  description: string;
  /** Positional arguments (in order). */
  args?: CommandArg[];
  /** Flags specific to this subcommand. (Global flags are added separately by the CLI.) */
  flags?: CommandFlag[];
  /** Action names this subcommand drives. Useful for downstream tooling that wants the
   *  ActionDefinition wiring without running the CLI. */
  actions: string[];
  /** Risk classification for documentation. */
  risk: 'read' | 'low' | 'medium' | 'high';
}

export interface CliMetadata {
  /** CLI binary name, e.g. `agentkit-gns`. */
  bin: string;
  /** One-line summary. */
  summary: string;
  subcommands: SubcommandMetadata[];
}
