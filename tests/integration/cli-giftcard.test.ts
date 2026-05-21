import { describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

// See cli-gns.test.ts: tsx cold-start under full-suite load can exceed
// vitest's default 5s test timeout. Give spawns generous headroom.
vi.setConfig({ testTimeout: 30_000 });

const exec = promisify(execFile);
const REPO_ROOT = resolve(__dirname, '..', '..');
const BIN = resolve(REPO_ROOT, 'bin', 'giftcard.mjs');

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

async function runCli(args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<RunResult> {
  try {
    const { stdout, stderr } = await exec('node', [BIN, ...args], {
      cwd: REPO_ROOT,
      timeout: 25_000,
      env: { ...process.env, ...env },
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | null };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? null };
  }
}

describe('agentkit-giftcard CLI', () => {
  it('shows --help with all 8 subcommands', async () => {
    const { stdout, code } = await runCli(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('agentkit-giftcard');
    const subcommands = [
      'regions',
      'list-brands',
      'get-brand',
      'list-chains',
      'buy',
      'status',
      'list-orders',
      'doctor',
    ];
    for (const sub of subcommands) {
      expect(stdout).toContain(sub);
    }
  });

  it('doctor --json produces a structured report', async () => {
    const { stdout, code } = await runCli(['doctor', '--json'], { GIFTCARD_API_BASE_URL: 'http://127.0.0.1:1' });
    expect([0, 1]).toContain(code);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty('env');
    expect(parsed).toHaveProperty('api');
    expect(parsed).toHaveProperty('wallet');
    expect(Array.isArray(parsed.env)).toBe(true);
  });
});
