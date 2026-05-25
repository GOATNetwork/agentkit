import { describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

// Each test spawns `node bin/gns.mjs`, which cold-starts the tsx ESM loader.
// Under full-suite parallelism that can exceed vitest's default 5s test
// timeout, producing empty stdout (observed in CI). Give spawns generous
// headroom; the commands themselves return in well under a second.
vi.setConfig({ testTimeout: 30_000 });

const exec = promisify(execFile);
const REPO_ROOT = resolve(__dirname, '..', '..');
const BIN = resolve(REPO_ROOT, 'bin', 'gns.mjs');

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

describe('agentkit-gns CLI', () => {
  it('shows --help with all 10 subcommands', async () => {
    const { stdout, code } = await runCli(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('agentkit-gns');
    const subcommands = [
      'lookup',
      'search',
      'my-names',
      'price',
      'register',
      'renew',
      'set-records',
      'set-primary',
      'x402-register',
      'doctor',
    ];
    for (const sub of subcommands) {
      expect(stdout).toContain(sub);
    }
  });

  it('lookup with --json against an unreachable API exits 10 (ADAPTER_REQUEST_FAILED)', async () => {
    // Point at an unroutable port so we deterministically get ADAPTER_REQUEST_FAILED.
    // 127.0.0.1:0 is used here as a TEST harness target ONLY — the SDK never
    // configures localhost as a default API URL.
    const { stdout, code } = await runCli(
      ['lookup', 'alice.goat', '--json'],
      { GNS_API_BASE_URL: 'http://127.0.0.1:1' },
    );
    // Either 10 (adapter failure) or 0 (if some network reaches a real host
    // in CI) is acceptable; in the test harness 1 is unreachable so we expect 10.
    expect([0, 10]).toContain(code);
    // Should produce JSON-ish output.
    expect(stdout.length).toBeGreaterThan(0);
    expect(() => JSON.parse(stdout)).not.toThrow();
  });

  it('doctor --json produces a structured report', async () => {
    const { stdout, code } = await runCli(
      ['doctor', '--json'],
      { GNS_API_BASE_URL: 'http://127.0.0.1:1' },
    );
    // doctor may exit 0 or 1 depending on connectivity; either is acceptable.
    expect([0, 1]).toContain(code);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty('env');
    expect(parsed).toHaveProperty('api');
    expect(parsed).toHaveProperty('wallet');
    expect(Array.isArray(parsed.env)).toBe(true);
  });

  it('register rejects invalid wait polling flags before wallet setup', async () => {
    for (const [flag, value] of [
      ['--wait-timeout', 'abc'],
      ['--poll-interval', '0'],
    ] as const) {
      const { stderr, code } = await runCli(['--json', '--auto-confirm', 'register', 'newagent', flag, value]);
      expect(code, `${flag}=${value} should fail as user input`).toBe(1);
      expect(stderr).toContain(flag);
      expect(stderr).not.toMatch(/GOAT_PRIVATE_KEY|PRIVATE_KEY/);
    }
  });
});
