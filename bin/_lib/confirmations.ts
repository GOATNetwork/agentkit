/**
 * TTY confirmation prompts.
 *
 * Behavior matrix (per Phase G spec):
 *   - `--auto-confirm` → always true, no prompt.
 *   - `--quiet`        → error if a prompt would have appeared.
 *   - non-TTY (no stdin.isTTY) → same as `--quiet` (no way to prompt).
 *   - TTY + no flags   → ask `[y/N]` via raw readline; require an explicit `y`.
 *
 * Intentionally avoids `@inquirer/prompts` to keep the SDK dependency
 * footprint small — the prompt is one line of text, one keypress.
 */
import * as readline from 'node:readline';

export interface ConfirmOptions {
  /** Auto-approve without prompting. */
  autoConfirm?: boolean;
  /** Refuse to prompt; throws ConfirmationRequiredError if a prompt would have appeared. */
  quiet?: boolean;
}

export class ConfirmationRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfirmationRequiredError';
  }
}

export async function confirm(prompt: string, opts: ConfirmOptions = {}): Promise<boolean> {
  if (opts.autoConfirm) return true;
  const isTTY = process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (opts.quiet || !isTTY) {
    throw new ConfirmationRequiredError(
      `confirmation required for: ${prompt} (re-run with --auto-confirm or attach a TTY)`,
    );
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr, // ask on stderr so stdout JSON pipelines stay clean
  });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(`${prompt} [y/N] `, (a) => resolve(a));
    });
    return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}
