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

  const answer = await ask(`${prompt} [y/N] `);
  return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
}

export interface SelectOption<T> {
  label: string;
  value: T;
}

export interface SelectOptions {
  /** Auto-pick the default option without prompting. */
  autoConfirm?: boolean;
  /** Refuse to prompt; throw ConfirmationRequiredError instead. */
  quiet?: boolean;
  /** Index of the option used for --auto-confirm / empty input. */
  defaultIndex?: number;
}

/**
 * Numbered-list selection prompt. Lists `label`s on stderr and reads a
 * 1-based index. Empty input picks the default. Mirrors `confirm`'s
 * autoConfirm / quiet / non-TTY behavior: `autoConfirm` returns the default
 * without prompting; `--quiet` or a non-TTY throws ConfirmationRequiredError
 * (a caller that wants a silent default should pass autoConfirm).
 */
export async function select<T>(
  prompt: string,
  options: readonly SelectOption<T>[],
  opts: SelectOptions = {},
): Promise<T> {
  if (options.length === 0) throw new Error('select: no options to choose from');
  const defaultIndex =
    opts.defaultIndex != null && opts.defaultIndex >= 0 && opts.defaultIndex < options.length ? opts.defaultIndex : 0;

  if (opts.autoConfirm) return options[defaultIndex].value;

  const isTTY = process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (opts.quiet || !isTTY) {
    throw new ConfirmationRequiredError(
      `selection required for: ${prompt} (re-run with --auto-confirm or attach a TTY)`,
    );
  }

  process.stderr.write(`${prompt}\n`);
  options.forEach((opt, i) => {
    const marker = i === defaultIndex ? ' (default)' : '';
    process.stderr.write(`  ${i + 1}) ${opt.label}${marker}\n`);
  });

  for (;;) {
    const answer = (await ask(`Select [1-${options.length}] `)).trim();
    if (answer === '') return options[defaultIndex].value;
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].value;
    process.stderr.write(`invalid choice: ${answer}\n`);
  }
}

/** Shared readline question on stderr with clean SIGINT handling. */
async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr, // ask on stderr so stdout JSON pipelines stay clean
  });
  try {
    return await new Promise<string>((resolve) => {
      // Ctrl+C during the prompt must exit cleanly with code 130 (128+SIGINT)
      // rather than leaving the promise unresolved or swallowing the signal.
      const onSigint = () => {
        rl.close();
        process.stderr.write('\naborted\n');
        process.exit(130);
      };
      rl.once('SIGINT', onSigint);
      rl.question(question, (a) => {
        rl.removeListener('SIGINT', onSigint);
        resolve(a);
      });
    });
  } finally {
    rl.close();
  }
}
