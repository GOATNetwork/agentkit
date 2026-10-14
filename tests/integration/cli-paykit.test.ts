import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createCliWorkspace } from '../fixtures/cli-workspace';
import { keccak256 } from 'ethers';
import { HASH, PAYTO, TOKEN, manifest, session, snapshot } from '../fixtures/paykit';
import { FilePaymentRecoveryStore } from '../../plugins/paykit';
import { paymentRequestKey } from '../../plugins/paykit/recovery';

vi.setConfig({ testTimeout: 30_000 });
const exec = promisify(execFile);
let workspace: Awaited<ReturnType<typeof createCliWorkspace>>;
let root: string;
let directory: string;
let origin: string;
let creations = 0;
let dropCreation = false;
let mppVerifications = 0;
let networkRead: (() => void) | undefined;
const server = createServer((request, response) => {
  if (request.url === '/hung-rpc') {
    networkRead?.();
    return;
  }
  response.setHeader('content-type', 'application/json');
  if (request.url?.endsWith('/manifest.json')) response.end(JSON.stringify(manifest));
  else if (request.url === '/quickpay/v1/fiat/sessions') {
    creations++;
    if (dropCreation) {
      request.socket.destroy();
      return;
    }
    response.end(
      JSON.stringify({
        checkout_id: 'cs-cli',
        url: `${origin}/paykit/direct?cs=cs-cli`,
        currency: 'USD',
        expires_at: 2000000000,
      }),
    );
  } else if (request.url === '/quickpay/v1/x402/sessions') response.end(JSON.stringify(session()));
  else if (request.url === '/quickpay/v1/x402/sessions/s1') response.end(JSON.stringify(snapshot()));
  else if (request.url === '/mpp/v1/challenge') {
    response.statusCode = 402;
    response.end(
      JSON.stringify({
        challenge_id: 'ch-cli',
        expiry: Math.floor(Date.now() / 1000) + 300,
        amount_wei: '1000000',
        chain_id: 4217,
        token_contract: TOKEN,
        recipient: PAYTO,
        mac: 'private-mac',
        route_pricing_version: 1,
      }),
    );
  } else if (request.url === '/mpp/v1/verify') {
    mppVerifications++;
    response.setHeader(
      'Payment-Receipt',
      `${Buffer.from('{"merchant_id":"acme"}').toString('base64url')}.signature.HS256`,
    );
    response.end('{}');
  } else {
    response.statusCode = 404;
    response.end('{}');
  }
});
beforeAll(async () => {
  workspace = await createCliWorkspace(true);
  root = workspace.root;
  directory = await mkdtemp(join(tmpdir(), 'paykit-cli-'));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server');
  origin = `http://127.0.0.1:${address.port}`;
}, 60_000);
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  if (directory) await rm(directory, { recursive: true, force: true });
  await workspace?.dispose();
});
async function run(args: string[], env: NodeJS.ProcessEnv = {}, nodeArgs: string[] = []) {
  try {
    const result = await exec(
      process.execPath,
      [...nodeArgs, join(root, 'bin/paykit.mjs'), '--state-dir', directory, ...args],
      {
        cwd: root,
        timeout: 25000,
        env: { ...process.env, PAYKIT_PRIVATE_KEY: '', GOAT_PRIVATE_KEY: '', ...env },
      },
    );
    return { ...result, code: 0 };
  } catch (error) {
    const e = error as { stdout: string; stderr: string; code: number };
    return { stdout: e.stdout, stderr: e.stderr, code: e.code };
  }
}

describe('agentkit-paykit CLI', () => {
  it.each([false, true])('reports a corrupt saved session body privately (known session: %s)', async (knownSession) => {
    const operationId = `corrupt-body-${knownSession}`;
    const store = new FilePaymentRecoveryStore(directory);
    await store.claim({
      kind: 'paykit',
      rail: 'x402',
      phase: 'requesting',
      origin,
      merchantId: 'acme',
      operationId,
      fingerprint: 'a'.repeat(64),
      chainId: 4217,
      sessionId: knownSession ? 's1' : undefined,
      sessionCreateBody: '{"private_note":PRIVATE-STORED-773}',
    });
    const result = await run(['--json', 'status', `${origin}/paykit/acme`, '--operation-id', operationId]);
    expect(result.code).toBe(10);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, errorCode: 'RECOVERY_REQUIRED' });
    expect(result.stdout + result.stderr).toContain('invalid x402 session creation body');
    expect(result.stdout + result.stderr).not.toContain('PRIVATE-STORED-773');
  });

  it.each(['prepared', 'missing', 'contradictory'] as const)(
    'identifies an unverified %s status operation without exposing journal data',
    async (state) => {
      const operationId = `unverified-${state}`;
      const fingerprint = 'a'.repeat(64);
      const store = new FilePaymentRecoveryStore(directory);
      if (state !== 'missing') {
        const record = {
          kind: 'paykit' as const,
          rail: 'x402' as const,
          phase: 'prepared' as const,
          origin,
          merchantId: 'acme',
          operationId,
          fingerprint,
          chainId: 4217,
          payer: `0x${'22'.repeat(20)}`,
        };
        await store.claim(record);
        if (state === 'contradictory')
          await store.claim({
            ...record,
            operationId: paymentRequestKey(record),
            phase: 'requesting',
            fingerprint: 'b'.repeat(64),
            sessionCreateBody: JSON.stringify({ token_contract: TOKEN }),
          });
      }
      for (const format of ['--json', '--human']) {
        const result = await run([
          '--auto-confirm',
          ...(format === '--json' ? [format] : []),
          'status',
          `${origin}/paykit/acme`,
          '--operation-id',
          operationId,
          '--expected-fingerprint',
          fingerprint,
        ]);
        expect(result.code).toBe(10);
        const text = result.stdout + result.stderr;
        expect(text).toContain(operationId);
        expect(text).toContain('unverified');
        expect(text).toContain('merchant status and transaction history');
        expect(text).not.toContain(`0x${'22'.repeat(20)}`);
        expect(text).not.toContain(fingerprint);
        if (format === '--json') expect(JSON.parse(result.stdout).recovery).toBeUndefined();
      }
    },
  );

  it.each([
    ['pay-mpp', 'key'],
    ['pay-mpp', 'rpc'],
    ['resume-mpp', 'key'],
  ] as const)('validates %s %s configuration before prompting or journal recovery', async (command, kind) => {
    const operationId = `mpp-config-${command}-${kind}`;
    const options =
      command === 'pay-mpp'
        ? ['--route', 'GET:api:data', '--chain-id', '4217', '--idempotency-key', operationId]
        : ['--operation-id', operationId];
    const result = await run(
      [command, `${origin}/paykit/acme`, ...options, '--json', ...(kind === 'rpc' ? ['--rpc-url', 'not-a-url'] : [])],
      { PAYKIT_PRIVATE_KEY: kind === 'key' ? '' : `0x${'01'.repeat(32)}`, PAYKIT_EMERGENCY_DIR: '' },
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      errorCode: 'INVALID_INPUT',
      error: expect.stringContaining(kind === 'key' ? 'PRIVATE_KEY' : 'RPC URL'),
    });
    expect(await new FilePaymentRecoveryStore(directory).get(operationId)).toBeUndefined();
  });

  it.each(['pay-mpp', 'resume-mpp', 'create-card-checkout'] as const)(
    'preflights a nested emergency directory before %s can prompt or execute',
    async (command) => {
      const before = { creations, mppVerifications };
      const nested = join(directory, `nested-${command}`);
      await mkdir(nested, { mode: 0o700 });
      const operationId = `preflight-${command}`;
      const commandOptions =
        command === 'pay-mpp'
          ? ['--route', 'GET:api:data', '--chain-id', '4217', '--idempotency-key', operationId]
          : command === 'resume-mpp'
            ? ['--operation-id', operationId]
            : ['--amount', '1', '--idempotency-key', operationId];
      const result = await run(
        [
          command,
          `${origin}/paykit/acme`,
          ...commandOptions,
          '--emergency-dir',
          nested,
          '--rpc-url',
          `${origin}/hung-rpc`,
          '--json',
        ],
        { PAYKIT_PRIVATE_KEY: `0x${'01'.repeat(32)}` },
      );
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        errorCode: 'INVALID_INPUT',
        error: expect.stringContaining('outside the primary journal'),
      });
      expect({ creations, mppVerifications }).toEqual(before);
      expect(await new FilePaymentRecoveryStore(directory).get(operationId)).toBeUndefined();
    },
  );

  it.each(['key', 'rpc', 'emergency'] as const)(
    'reports invalid %s configuration before asking for payment confirmation',
    async (kind) => {
      const before = creations;
      const args = [
        'pay-x402',
        `${origin}/paykit/acme`,
        '--amount',
        '1',
        '--chain-id',
        '4217',
        '--token',
        'USDC',
        '--idempotency-key',
        `preflight-${kind}`,
        '--json',
      ];
      if (kind === 'rpc') args.push('--rpc-url', 'not-a-url');
      if (kind === 'emergency') args.push('--emergency-dir', directory);
      const result = await run(args, {
        PAYKIT_PRIVATE_KEY: kind === 'key' ? '' : `0x${'01'.repeat(32)}`,
        PAYKIT_EMERGENCY_DIR: '',
      });
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        errorCode: 'INVALID_INPUT',
        error: expect.stringContaining(
          kind === 'key' ? 'PRIVATE_KEY' : kind === 'rpc' ? 'RPC URL' : 'outside the primary journal',
        ),
      });
      expect(creations).toBe(before);
      expect(await new FilePaymentRecoveryStore(directory).get(`preflight-${kind}`)).toBeUndefined();
    },
  );

  it.each(['inspect', 'status'])('does not gate %s on an unused emergency parent', async (command) => {
    const result = await run([
      command,
      `${origin}/paykit/acme`,
      ...(command === 'status' ? ['--session-id', 's1'] : []),
      '--emergency-dir',
      join(directory, 'missing-emergency'),
      '--json',
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true });
    expect(result.stderr).not.toContain('Emergency directory');
  });

  it('uses the trimmed state-directory environment value for actual journal writes', async () => {
    const state = join(directory, 'trimmed-environment');
    const response = await exec(
      process.execPath,
      [
        join(root, 'bin/paykit.mjs'),
        'create-card-checkout',
        `${origin}/paykit/acme`,
        '--amount',
        '1',
        '--idempotency-key',
        'trimmed-env',
        '--auto-confirm',
        '--json',
      ],
      {
        cwd: root,
        timeout: 25000,
        env: { ...process.env, PAYKIT_STATE_DIR: `  ${state}  `, PAYKIT_EMERGENCY_DIR: '' },
      },
    );
    expect(JSON.parse(response.stdout)).toMatchObject({ ok: true });
    expect(await new FilePaymentRecoveryStore(state).get('trimmed-env')).toMatchObject({ phase: 'complete' });
  });
  it('rejects an emergency parent inside the primary journal before creating a checkout', async () => {
    const before = creations;
    const response = await run([
      'create-card-checkout',
      `${origin}/paykit/acme`,
      '--amount',
      '1',
      '--idempotency-key',
      'invalid-emergency',
      '--auto-confirm',
      '--emergency-dir',
      directory,
      '--json',
    ]);
    expect(response.code).toBe(1);
    expect(JSON.parse(response.stdout)).toMatchObject({
      errorCode: 'INVALID_INPUT',
      error: expect.stringContaining('outside the primary journal'),
    });
    expect(creations).toBe(before);
    expect(await new FilePaymentRecoveryStore(directory).get('invalid-emergency')).toBeUndefined();
  });
  it('ignores an empty state directory from .env and rejects an explicitly blank flag', async () => {
    const cwd = await mkdtemp(join(directory, 'empty-state-env-'));
    await writeFile(join(cwd, '.env'), 'PAYKIT_STATE_DIR=\n');
    const help = await exec(process.execPath, [join(root, 'bin/paykit.mjs'), '--help'], {
      cwd,
      env: { ...process.env, PAYKIT_STATE_DIR: '' },
    });
    expect(help.stdout).toContain(join(homedir(), '.agentkit', 'paykit'));
    const blank = await run([
      '--state-dir',
      '',
      'create-card-checkout',
      `${origin}/paykit/acme`,
      '--amount',
      '1',
      '--idempotency-key',
      'empty-state',
      '--auto-confirm',
      '--json',
    ]);
    expect(blank.code).toBe(1);
    expect(JSON.parse(blank.stdout)).toMatchObject({
      errorCode: 'INVALID_INPUT',
      error: expect.stringContaining('must not be empty'),
    });
  });
  it('runs the real PayKit shim through tsx in a source-only workspace', async () => {
    const source = await createCliWorkspace();
    try {
      await expect(stat(join(source.root, 'dist'))).rejects.toMatchObject({ code: 'ENOENT' });
      const result = await exec(
        process.execPath,
        [join(source.root, 'bin/paykit.mjs'), 'inspect', `${origin}/paykit/acme`, '--json'],
        {
          cwd: source.root,
          timeout: 25000,
        },
      );
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, output: { merchant_id: 'acme' } });
    } finally {
      await source.dispose();
    }
  });

  it('rejects timer overflow and prints root paths for object-level validation errors', async () => {
    const overflow = await run(['inspect', `${origin}/paykit/acme`, '--timeout-ms', String(2 ** 31), '--json']);
    expect(overflow.code).toBe(1);
    expect(overflow.stderr).toContain('Timeout must be at most');
    expect(overflow.stderr).not.toContain('TimeoutOverflowWarning');
    const largest = await run(['inspect', `${origin}/paykit/acme`, '--timeout-ms', String(2 ** 31 - 1), '--json']);
    expect(largest.code).toBe(0);
    const invalid = await run([
      'create-card-checkout',
      `${origin}/paykit/acme`,
      '--amount',
      '1',
      '--product',
      'mug',
      '--idempotency-key',
      'bad-refinement',
      '--json',
    ]);
    expect(invalid.code).toBe(1);
    expect(JSON.parse(invalid.stdout).error).toContain('root: Provide exactly one');
  });

  it.each(['pay-x402', 'create-card-checkout'])(
    'preserves an unsaved %s result and replays only from its emergency journal',
    async (command) => {
      const operationId = `completion-write-failure-${command}`;
      const broadcastLog = join(directory, `${operationId}.log`);
      const emergencyParent = join(root, 'emergency-parent');
      if (command === 'create-card-checkout') await mkdir(emergencyParent, { mode: 0o700 });
      const args = [
        '--state-dir',
        `  ${directory}  `,
        command,
        `${origin}/paykit/acme`,
        '--amount',
        '1',
        '--idempotency-key',
        operationId,
        ...(command === 'pay-x402' ? ['--chain-id', '4217', '--token', 'USDC', '--rpc-url', 'http://127.0.0.1:1'] : []),
        '--auto-confirm',
        '--json',
      ];
      const env = {
        ...(command === 'create-card-checkout' ? { PAYKIT_EMERGENCY_DIR: `  ${emergencyParent}  ` } : {}),
        PAYKIT_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
        PAYKIT_TEST_BROADCAST_LOG: broadcastLog,
        PAYKIT_TEST_BROADCAST_DELAY_MS: '0',
        PAYKIT_TEST_FAIL_COMPLETION_DIR: directory,
      };
      const preload = ['--import', join(root, 'tests/fixtures/paykit-delayed-broadcast.mjs')];
      const before = creations;
      const result = await run(args, env, preload);
      const output = JSON.parse(result.stdout);
      const emergency = output.recovery.emergencyStateDir;
      try {
        expect(result.code).toBe(10);
        expect(output).toMatchObject({
          errorCode: 'ADAPTER_REQUEST_FAILED',
          error: 'Insufficient storage for the payment journal',
        });
        if (command === 'create-card-checkout') {
          expect(dirname(emergency)).toBe(await realpath(emergencyParent));
          expect(result.stderr).toContain('Move the entire directory to durable private storage');
          expect(output.recovery.emergencyStorageWarnings).toEqual([
            expect.stringContaining('shares the primary journal filesystem'),
          ]);
        } else expect(result.stderr).toContain('Move the entire directory to durable private storage');
        expect(output.recovery).toMatchObject({
          phase: 'complete',
          persistenceError: expect.stringContaining('completed result'),
          recoveryHint: expect.stringContaining('emergency --state-dir'),
          emergencyStateDir: expect.any(String),
          result:
            command === 'pay-x402'
              ? { session_id: '[REDACTED]', tx_hash: HASH }
              : { checkout_id: '[REDACTED]', url: '[REDACTED]' },
        });
        const primary = await run(args, env, preload);
        expect(JSON.parse(primary.stdout)).toMatchObject({ ok: false, errorCode: 'RECOVERY_REQUIRED' });
        const replay = await run([...args, '--state-dir', emergency, '--reveal-secrets'], env, preload);
        expect(replay.code).toBe(0);
        expect(JSON.parse(replay.stdout).output).toMatchObject(
          command === 'pay-x402'
            ? { session_id: 's1', tx_hash: HASH }
            : { checkout_id: 'cs-cli', url: `${origin}/paykit/direct?cs=cs-cli` },
        );
        if (command === 'pay-x402') {
          const statusArgs = [
            'status',
            `${origin}/paykit/acme`,
            '--operation-id',
            operationId,
            '--state-dir',
            emergency,
            '--json',
            '--expected-fingerprint',
          ];
          const pinned = await run([...statusArgs, output.recovery.fingerprint]);
          expect(pinned.code).toBe(0);
          expect(JSON.parse(pinned.stdout)).toMatchObject({ ok: true, output: { status: 'PAYMENT_CONFIRMED' } });
          const rejected = await run([...statusArgs, 'f'.repeat(64)]);
          expect(rejected.code).toBe(10);
          expect(JSON.parse(rejected.stdout)).toMatchObject({ errorCode: 'RECOVERY_REQUIRED' });
          expect(JSON.parse(rejected.stdout).recovery).toBeUndefined();
        }
        expect(creations).toBe(before + (command === 'create-card-checkout' ? 1 : 0));
        if (command === 'pay-x402') expect(await readFile(broadcastLog, 'utf8')).toBe('accepted\n');
      } finally {
        if (emergency) await rm(emergency, { recursive: true, force: true });
      }
    },
  );

  it('reports malformed links as input errors and journal I/O as adapter errors', async () => {
    const invalid = await run(['inspect', `${origin}/not-paykit`, '--json']);
    expect(invalid.code).toBe(1);
    expect(JSON.parse(invalid.stdout)).toMatchObject({
      errorCode: 'INVALID_INPUT',
      error: expect.stringContaining('PayKit link'),
    });
    const file = join(directory, 'not-a-directory');
    await writeFile(file, 'occupied');
    const blocked = await run([
      '--state-dir',
      file,
      'create-card-checkout',
      `${origin}/paykit/acme`,
      '--amount',
      '1',
      '--idempotency-key',
      'io-error',
      '--auto-confirm',
      '--json',
    ]);
    expect(blocked.code).toBe(10);
    expect(JSON.parse(blocked.stdout)).toMatchObject({
      errorCode: 'ADAPTER_REQUEST_FAILED',
      error: 'Payment journal path is not a directory',
    });
    expect(blocked.stdout).not.toContain(file);
  });

  it('Ctrl-C interrupts stalled RPC network detection without waiting for the action timeout', async () => {
    const detected = new Promise<void>((resolve) => {
      networkRead = resolve;
    });
    const child = spawn(
      process.execPath,
      [
        join(root, 'bin/paykit.mjs'),
        '--state-dir',
        directory,
        '--rpc-url',
        `${origin}/hung-rpc`,
        '--timeout-ms',
        '120000',
        'pay-x402',
        `${origin}/paykit/acme`,
        '--amount',
        '1',
        '--chain-id',
        '4217',
        '--token',
        'USDC',
        '--idempotency-key',
        'hung-network',
        '--auto-confirm',
        '--json',
      ],
      {
        cwd: root,
        env: { ...process.env, PAYKIT_PRIVATE_KEY: `0x${'01'.repeat(32)}`, GOAT_PRIVATE_KEY: '' },
      },
    );
    let stdout = '';
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.resume();
    const closed = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const guard = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      await Promise.race([
        detected,
        closed.then(() => {
          throw new Error('CLI exited before network detection');
        }),
      ]);
      child.kill('SIGINT');
      expect(await closed).toMatchObject({ signal: null });
      expect(JSON.parse(stdout)).toMatchObject({ ok: false, errorCode: 'ABORTED' });
      expect(await new FilePaymentRecoveryStore(directory).get('hung-network')).toBeUndefined();
    } finally {
      clearTimeout(guard);
      networkRead = undefined;
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });
  it('warns on first Ctrl-C and force exits on the second during a stalled submission', async () => {
    const operationId = 'double-interrupt';
    const broadcastLog = join(directory, `${operationId}.log`);
    const child = spawn(
      process.execPath,
      [
        '--import',
        join(root, 'tests/fixtures/paykit-delayed-broadcast.mjs'),
        join(root, 'bin/paykit.mjs'),
        '--state-dir',
        directory,
        'pay-x402',
        `${origin}/paykit/acme`,
        '--amount',
        '1',
        '--token',
        'USDC',
        '--chain-id',
        '4217',
        '--idempotency-key',
        operationId,
        '--rpc-url',
        'http://127.0.0.1:1',
        '--timeout-ms',
        '120000',
        '--auto-confirm',
        '--json',
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          PAYKIT_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
          PAYKIT_TEST_BROADCAST_LOG: broadcastLog,
          PAYKIT_TEST_BROADCAST_DELAY_MS: '300000',
        },
      },
    );
    let stderr = '';
    child.stdout.resume();
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const closed = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const guard = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      await vi.waitFor(
        async () => {
          expect(await readFile(broadcastLog, 'utf8')).toBe('accepted\n');
        },
        { timeout: 3000 },
      );
      child.kill('SIGINT');
      await vi.waitFor(
        () => {
          expect(stderr).toContain('Press Ctrl-C again');
        },
        { timeout: 1000 },
      );
      expect(child.exitCode).toBeNull();
      child.kill('SIGINT');
      expect(await closed).toEqual({ code: 130, signal: null });
      expect(stderr).toContain('Inspect the payment journal');
      expect(await new FilePaymentRecoveryStore(directory).get(operationId)).toMatchObject({
        phase: 'submitting',
        signedTxHash: keccak256('0xdeadbeef'),
      });
      expect(await readFile(broadcastLog, 'utf8')).toBe('accepted\n');
    } finally {
      clearTimeout(guard);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    }
  });

  it('reports compiled-module import failures with startup diagnostics', async () => {
    const startup = join(directory, 'broken-cli');
    await mkdir(join(startup, 'bin'), { recursive: true });
    await mkdir(join(startup, 'dist/bin/_lib'), { recursive: true });
    await copyFile(join(root, 'bin/paykit.mjs'), join(startup, 'bin/paykit.mjs'));
    await writeFile(join(startup, 'package.json'), '{"type":"module"}');
    await writeFile(join(startup, 'dist/bin/_lib/cli-paykit.js'), "import './missing-runtime-dependency.js';");
    await expect(exec(process.execPath, [join(startup, 'bin/paykit.mjs')], { cwd: startup })).rejects.toMatchObject({
      code: 99,
      stderr: expect.stringMatching(/CLI module failed to load \(ERR_MODULE_NOT_FOUND\).*missing-runtime-dependency/),
    });
  });

  it('prints actionable preflight errors and allows the same key after correction', async () => {
    const before = creations;
    const args = [
      'create-card-checkout',
      `${origin}/paykit/acme`,
      '--idempotency-key',
      'preflight-cli',
      '--auto-confirm',
      '--json',
    ];
    const invalid = await run([...args, '--amount', '1.001']);
    expect(JSON.parse(invalid.stdout)).toMatchObject({
      ok: false,
      errorCode: 'INVALID_INPUT',
      error: expect.stringContaining('precision'),
    });
    expect(creations).toBe(before);
    expect(await new FilePaymentRecoveryStore(directory).get('preflight-cli')).toBeUndefined();
    const fixed = await run([...args, '--amount', '1']);
    expect(fixed.code).toBe(0);
    expect(creations).toBe(before + 1);
  });
  it('ships help for all seven commands', async () => {
    const result = await run(['--help']);
    expect(result.code).toBe(0);
    for (const command of [
      'inspect',
      'pay-x402',
      'pay-product',
      'status',
      'pay-mpp',
      'resume-mpp',
      'create-card-checkout',
    ])
      expect(result.stdout).toContain(command);
  });
  it('inspects and reads session status without any wallet key', async () => {
    const inspect = await run(['inspect', `${origin}/paykit/acme`, '--json']);
    expect(inspect.code).toBe(0);
    expect(JSON.parse(inspect.stdout)).toMatchObject({ ok: true, output: { merchant_id: 'acme' } });
    const status = await run(['status', `${origin}/paykit/acme`, '--session-id', 's1', '--json']);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout).output).toMatchObject({ status: 'PAYMENT_CONFIRMED', sessionId: '[REDACTED]' });
  });
  it('requires confirmation and validates incompatible input before side effects', async () => {
    const before = creations;
    const unconfirmed = await run([
      'create-card-checkout',
      `${origin}/paykit/acme`,
      '--product',
      'mug',
      '--idempotency-key',
      'confirm',
      '--json',
    ]);
    expect(unconfirmed.code).toBe(1);
    expect(JSON.parse(unconfirmed.stdout).error).toContain('confirmation required');
    const invalid = await run([
      'create-card-checkout',
      `${origin}/paykit/acme`,
      '--product',
      'mug',
      '--amount',
      '1',
      '--idempotency-key',
      'invalid',
      '--auto-confirm',
      '--json',
    ]);
    expect(invalid.code).toBe(1);
    expect(creations).toBe(before);
  });
  it('returns a private card link and reuses the durable record across processes', async () => {
    const before = creations;
    const args = [
      'create-card-checkout',
      `${origin}/paykit/acme`,
      '--product',
      'mug',
      '--idempotency-key',
      'card-cli',
      '--auto-confirm',
      '--json',
    ];
    const first = await run(args);
    expect(first.code).toBe(0);
    expect(JSON.parse(first.stdout).output.url).toBe('[REDACTED]');
    expect(first.stderr).not.toContain('cs-cli');
    const second = await run([...args, '--reveal-secrets']);
    expect(second.code).toBe(0);
    expect(JSON.parse(second.stdout).output.url).toBe(`${origin}/paykit/direct?cs=cs-cli`);
    expect(creations).toBe(before + 1);
  });
  it('returns recovery context after a lost creation response and refuses a second POST', async () => {
    const before = creations;
    dropCreation = true;
    const args = [
      'create-card-checkout',
      `${origin}/paykit/acme`,
      '--amount',
      '1',
      '--idempotency-key',
      'lost-cli',
      '--auto-confirm',
      '--json',
    ];
    const first = await run(args);
    expect(first.code).toBe(10);
    expect(JSON.parse(first.stdout)).toMatchObject({
      ok: false,
      recovery: { operationId: 'lost-cli', phase: 'requesting' },
    });
    dropCreation = false;
    const second = await run(args);
    expect(second.code).toBe(10);
    expect(JSON.parse(second.stdout).errorCode).toBe('RECOVERY_REQUIRED');
    expect(creations).toBe(before + 1);
  });

  it.each([false, true])('preserves a verified MPP receipt when the journal fails (reveal %s)', async (reveal) => {
    const operationId = `receipt-disk-failure-${reveal}`;
    const broadcastLog = join(directory, `${operationId}.log`);
    const env = {
      PAYKIT_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
      PAYKIT_TEST_BROADCAST_LOG: broadcastLog,
      PAYKIT_TEST_BROADCAST_DELAY_MS: '0',
      PAYKIT_TEST_FAIL_STATE_DIR: directory,
    };
    const before = mppVerifications;
    const result = await run(
      [
        'pay-mpp',
        `${origin}/paykit/acme`,
        '--chain-id',
        '4217',
        '--route',
        'GET:api:data',
        '--idempotency-key',
        operationId,
        '--rpc-url',
        'http://127.0.0.1:1',
        '--auto-confirm',
        '--json',
        ...(reveal ? ['--reveal-secrets'] : []),
      ],
      env,
      ['--import', join(root, 'tests/fixtures/paykit-delayed-broadcast.mjs')],
    );
    const output = JSON.parse(result.stdout);
    const emergency = output.recovery.emergencyStateDir;
    try {
      expect(result.code).toBe(10);
      expect(output).toMatchObject({
        errorCode: 'ADAPTER_REQUEST_FAILED',
        error: 'Insufficient storage for the payment journal',
        recovery: {
          persistenceError: expect.stringContaining('verified MPP receipt'),
          emergencyStateDir: expect.any(String),
          result: { receiptHeader: reveal ? expect.stringContaining('.signature.HS256') : '[REDACTED]' },
        },
      });
      expect(result.stderr).toContain('checkpoint failed');
      expect(result.stderr).toContain('Move the entire directory to durable private storage');
      expect(result.stderr).not.toContain('.signature.HS256');
      const resumed = await run(
        [
          'resume-mpp',
          `${origin}/paykit/acme`,
          '--operation-id',
          operationId,
          '--state-dir',
          emergency,
          '--expected-fingerprint',
          output.recovery.fingerprint,
          '--reveal-secrets',
          '--json',
        ],
        { PAYKIT_PRIVATE_KEY: env.PAYKIT_PRIVATE_KEY },
      );
      expect(resumed.code).toBe(0);
      expect(JSON.parse(resumed.stdout).output.receiptHeader).toContain('.signature.HS256');
      const rejected = await run(
        [
          'resume-mpp',
          `${origin}/paykit/acme`,
          '--operation-id',
          operationId,
          '--state-dir',
          emergency,
          '--expected-fingerprint',
          'f'.repeat(64),
          '--reveal-secrets',
          '--json',
        ],
        { PAYKIT_PRIVATE_KEY: env.PAYKIT_PRIVATE_KEY },
      );
      expect(rejected.code).toBe(10);
      expect(JSON.parse(rejected.stdout)).toMatchObject({ errorCode: 'RECOVERY_REQUIRED' });
      expect(JSON.parse(rejected.stdout).recovery).toBeUndefined();
      expect(rejected.stdout).not.toContain('.signature.HS256');
      expect(mppVerifications).toBe(before + 1);
      expect(await readFile(broadcastLog, 'utf8')).toBe('accepted\n');
    } finally {
      if (emergency) await rm(emergency, { recursive: true, force: true });
    }
  });

  it.each([false, true])('reports a durable late MPP success with normal redaction (reveal %s)', async (reveal) => {
    const operationId = `complete-after-timeout-${reveal}`;
    const broadcastLog = join(directory, `${operationId}.log`);
    const result = await run(
      [
        'pay-mpp',
        `${origin}/paykit/acme`,
        '--chain-id',
        '4217',
        '--route',
        'GET:api:data',
        '--idempotency-key',
        operationId,
        '--rpc-url',
        'http://127.0.0.1:1',
        '--timeout-ms',
        '1000',
        '--auto-confirm',
        '--json',
        ...(reveal ? ['--reveal-secrets'] : []),
      ],
      {
        PAYKIT_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
        PAYKIT_TEST_BROADCAST_LOG: broadcastLog,
        PAYKIT_TEST_BROADCAST_DELAY_MS: '0',
        PAYKIT_TEST_COMPLETION_DELAY_MS: '1500',
      },
      ['--import', join(root, 'tests/fixtures/paykit-delayed-broadcast.mjs')],
    );
    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      ok: true,
      output: {
        txHash: HASH,
        receiptHeader: reveal ? expect.stringContaining('.signature.HS256') : '[REDACTED]',
        receiptBody: reveal ? { merchant_id: 'acme' } : '[REDACTED]',
      },
    });
    expect(output).not.toHaveProperty('errorCode');
    expect(result.stderr).toContain('completed while waiting');
    expect(result.stderr).not.toContain('.signature.HS256');
    expect(await readFile(broadcastLog, 'utf8')).toBe('accepted\n');
    expect(await new FilePaymentRecoveryStore(directory).get(operationId)).toMatchObject({ phase: 'complete' });
  });

  it.each(['pay-x402', 'pay-mpp'])('drains a late %s broadcast before exiting on timeout', async (command) => {
    const operationId = `late-${command}`;
    const broadcastLog = join(directory, `${operationId}.log`);
    const env = { PAYKIT_PRIVATE_KEY: `0x${'11'.repeat(32)}`, PAYKIT_TEST_BROADCAST_LOG: broadcastLog };
    const before = mppVerifications;
    const result = await run(
      [
        command,
        `${origin}/paykit/acme`,
        '--chain-id',
        '4217',
        '--idempotency-key',
        operationId,
        ...(command === 'pay-mpp' ? ['--route', 'GET:api:data'] : ['--token', 'USDC', '--amount', '1']),
        '--rpc-url',
        'http://127.0.0.1:1',
        '--timeout-ms',
        '1000',
        '--auto-confirm',
        '--json',
      ],
      env,
      ['--import', join(root, 'tests/fixtures/paykit-delayed-broadcast.mjs')],
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      errorCode: 'TIMEOUT',
      recovery: { operationId, phase: 'broadcast', txHash: HASH },
    });
    expect(await readFile(broadcastLog, 'utf8')).toBe('accepted\n');
    const record = await new FilePaymentRecoveryStore(directory).get(operationId);
    expect(record).toMatchObject({ phase: 'broadcast', txHash: HASH });
    expect(result.stdout).not.toContain('private-mac');
    expect(result.stderr).not.toContain('private-mac');
    expect(mppVerifications).toBe(before);
    if (command === 'pay-mpp') {
      const resumed = await run(['resume-mpp', `${origin}/paykit/acme`, '--operation-id', operationId, '--json'], env);
      expect(resumed.code).toBe(0);
      expect(JSON.parse(resumed.stdout)).toMatchObject({ ok: true, output: { txHash: HASH } });
      expect(mppVerifications).toBe(before + 1);
      expect(await readFile(broadcastLog, 'utf8')).toBe('accepted\n');
    }
  });
});
