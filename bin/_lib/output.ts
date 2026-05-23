/**
 * Output formatting helpers shared by the agentkit-gns / agentkit-giftcard
 * CLIs. Two modes:
 *
 *   - `'json'`   — `JSON.stringify(value, null, 2)` to stdout.
 *   - `'human'`  — best-effort pretty print using plain text + ANSI escapes.
 *
 * No external dependencies (no chalk / kleur etc.). ANSI escapes are
 * intentionally minimal so output stays grep-friendly in non-TTY contexts.
 */

export type OutputFormat = 'human' | 'json';

const ANSI = {
  reset: '[0m',
  bold: '[1m',
  dim: '[2m',
  red: '[31m',
  green: '[32m',
  yellow: '[33m',
  cyan: '[36m',
} as const;

function supportsColor(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return process.stdout.isTTY === true;
}

function color(code: string, value: string): string {
  return supportsColor() ? `${code}${value}${ANSI.reset}` : value;
}

/** Emit a value to stdout. JSON mode pretty-prints; human mode delegates to `humanPrint`. */
export function emit(value: unknown, format: OutputFormat): void {
  if (format === 'json') {
    process.stdout.write(JSON.stringify(value, null, 2) + '\n');
    return;
  }
  humanPrint(value);
}

/** Pretty-print arbitrary values for terminal display. */
export function humanPrint(value: unknown, indent = 0): void {
  const pad = ' '.repeat(indent);
  if (value == null) {
    process.stdout.write(`${pad}${color(ANSI.dim, String(value))}\n`);
    return;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    process.stdout.write(`${pad}${String(value)}\n`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      process.stdout.write(`${pad}${color(ANSI.dim, '(empty)')}\n`);
      return;
    }
    value.forEach((item, i) => {
      process.stdout.write(`${pad}${color(ANSI.cyan, `[${i}]`)}\n`);
      humanPrint(item, indent + 2);
    });
    return;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      process.stdout.write(`${pad}${color(ANSI.dim, '(empty)')}\n`);
      return;
    }
    for (const [k, v] of entries) {
      if (v != null && (typeof v === 'object' || Array.isArray(v))) {
        process.stdout.write(`${pad}${color(ANSI.bold, k)}:\n`);
        humanPrint(v, indent + 2);
      } else {
        process.stdout.write(`${pad}${color(ANSI.bold, k)}: ${String(v)}\n`);
      }
    }
    return;
  }
  process.stdout.write(`${pad}${String(value)}\n`);
}

/** Emit a status line (info / ok / warn / error) — stays on stderr so JSON
 *  pipelines on stdout aren't polluted. */
export function status(level: 'info' | 'ok' | 'warn' | 'error', message: string): void {
  const stamp =
    level === 'ok'
      ? color(ANSI.green, '✓')
      : level === 'warn'
      ? color(ANSI.yellow, '!')
      : level === 'error'
      ? color(ANSI.red, '✗')
      : color(ANSI.cyan, '▶');
  process.stderr.write(`${stamp} ${message}\n`);
}
