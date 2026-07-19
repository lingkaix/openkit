import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ChildProcessOpenShellRunner,
  compileOpenShellSandboxCreateArgs,
  compileOpenShellSandboxExecArgs,
  compileOpenShellSupervisedCommand,
  OpenShellCli,
  type OpenShellCommandRunner,
} from './openshell-cli.js';

const workerInferenceProfile = {
  binaries: ['/usr/local/bin/codex', '/usr/local/lib/codex/bin/codex'],
  category: 'inference',
  credentials: [
    {
      auth_style: 'bearer',
      description: 'Package-bound scheduler lease token',
      env_vars: ['OPENKIT_WORKER_INFERENCE_TOKEN'],
      header_name: 'Authorization',
      name: 'session_token',
      query_param: '',
      required: true,
    },
  ],
  description: 'Package-bound NanoCore worker inference relay',
  display_name: 'OpenKit Worker Inference',
  endpoints: [
    {
      enforcement: 'enforce',
      host: 'host.openshell.internal',
      port: 54002,
      protocol: 'rest',
      rules: [
        {
          allow: {
            method: 'POST',
            path: '/api/worker-inference/v1/chat/completions',
          },
        },
        {
          allow: {
            method: 'POST',
            path: '/api/worker-inference/v1/responses',
          },
        },
      ],
    },
  ],
  id: 'okp-local-worker-inference-0123456789abcdef',
  inference_capable: false,
} as const;
const workerInferenceProfilePath = join(
  mkdtempSync(join(tmpdir(), 'openkit-openshell-profile-')),
  'worker-inference-provider-profile.json'
);

writeFileSync(workerInferenceProfilePath, JSON.stringify(workerInferenceProfile), 'utf8');

class FakeOpenShellCommandRunner implements OpenShellCommandRunner {
  public readonly calls: string[][] = [];
  public readonly options: Array<Parameters<OpenShellCommandRunner['run']>[1]> = [];

  private readonly outputs: Array<{ exitCode: number; stdout: string; stderr?: string }>;

  public constructor(outputs: Array<{ exitCode: number; stdout: string; stderr?: string }>) {
    this.outputs = [...outputs];
  }

  public async run(
    args: string[],
    options?: Parameters<OpenShellCommandRunner['run']>[1]
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    this.calls.push(args);
    this.options.push(options);
    const output = this.outputs.shift();

    if (!output) {
      throw new Error(`Unexpected OpenShell command: ${args.join(' ')}`);
    }

    return {
      exitCode: output.exitCode,
      stdout: output.stdout,
      stderr: output.stderr ?? '',
    };
  }
}

describe('OpenShellCli', () => {
  it('removes inherited OpenShell target overrides before launching the official CLI', async () => {
    const runner = new ChildProcessOpenShellRunner(process.execPath);

    await expect(
      runner.run(
        [
          '-e',
          'process.stdout.write(JSON.stringify([process.env.OPENSHELL_GATEWAY??null,process.env.OPENSHELL_GATEWAY_ENDPOINT??null,process.env.OPENSHELL_GATEWAY_INSECURE??null]))',
        ],
        {
          env: {
            OPENSHELL_GATEWAY: 'untrusted-gateway',
            OPENSHELL_GATEWAY_ENDPOINT: 'https://untrusted.example.com',
            OPENSHELL_GATEWAY_INSECURE: '1',
          },
        }
      )
    ).resolves.toEqual({ exitCode: 0, stderr: '', stdout: '[null,null,null]' });
  });

  it.each([
    0, 7,
  ])('returns supervised command exit code %s before its deadline', async (exitCode) => {
    const runner = new ChildProcessOpenShellRunner(process.execPath);

    await expect(
      runner.run(['-e', `process.stdout.write('settled');process.exit(${exitCode})`], {
        timeoutMs: 500,
      })
    ).resolves.toEqual({ exitCode, stderr: '', stdout: 'settled' });
  });

  it.skipIf(process.platform === 'win32')(
    'kills a late command after its NanoCore parent is force-killed',
    async () => {
      const testRoot = mkdtempSync(join(tmpdir(), 'openkit-openshell-supervisor-'));
      const markerPath = join(testRoot, 'late-completion');
      const readyPath = join(testRoot, 'ready');
      const supervised = compileOpenShellSupervisedCommand(
        process.execPath,
        [
          '-e',
          `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(readyPath)},'ready');setTimeout(()=>fs.writeFileSync(${JSON.stringify(markerPath)},'late'),50)`,
        ],
        10_000
      );
      const parent = spawn(
        process.execPath,
        [
          '-e',
          "const {spawn}=require('node:child_process');const command=JSON.parse(process.env.OPENKIT_TEST_SUPERVISED_COMMAND);const child=spawn(command.command,command.args,{detached:true,stdio:['ignore','ignore','ignore','pipe']});process.stdout.write(String(child.pid)+'\\n');setInterval(()=>{},1000)",
        ],
        {
          env: {
            ...process.env,
            OPENKIT_TEST_SUPERVISED_COMMAND: JSON.stringify(supervised),
          },
          stdio: ['ignore', 'pipe', 'inherit'],
        }
      );
      const supervisorPid = await new Promise<number>((resolve, reject) => {
        parent.once('error', reject);
        parent.stdout.once('data', (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
      });

      try {
        for (let attempt = 0; attempt < 100 && !existsSync(readyPath); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(existsSync(readyPath)).toBe(true);
        process.kill(parent.pid!, 'SIGKILL');
        rmSync(markerPath, { force: true });
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(existsSync(markerPath)).toBe(false);
        expect(() => process.kill(supervisorPid, 0)).toThrow();
      } finally {
        try {
          process.kill(-supervisorPid, 'SIGKILL');
        } catch {
          // The supervisor should already have exited after enforcing its deadline.
        }
      }
    }
  );

  it('waits for a TERM-resistant process to be force-killed before timeout settlement', async () => {
    const runner = new ChildProcessOpenShellRunner(process.execPath);
    const startedAt = Date.now();

    await expect(
      runner.run(
        [
          '-e',
          "process.on('SIGTERM',()=>{});setInterval(()=>process.stdout.write('active\\n'),20)",
        ],
        { timeoutMs: 100 }
      )
    ).rejects.toThrow('timed out after 100ms');
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(180);
  });

  it.skipIf(process.platform === 'win32')(
    'force-kills same-group descendants after the direct CLI leader exits',
    async () => {
      const markerPath = join(
        mkdtempSync(join(tmpdir(), 'openkit-openshell-descendant-')),
        'descendant-survived'
      );
      const descendantSource = `process.on('SIGTERM',()=>{});setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(markerPath)},'late'),350);setInterval(()=>{},1000)`;
      const leaderSource = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendantSource)}],{detached:false,stdio:'ignore'});setInterval(()=>{},1000)`;
      const runner = new ChildProcessOpenShellRunner(process.execPath);

      await expect(runner.run(['-e', leaderSource], { timeoutMs: 150 })).rejects.toThrow(
        'timed out after 150ms'
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(existsSync(markerPath)).toBe(false);
    }
  );

  it('parses version, status, and gateway output from the real CLI shape', async () => {
    const runner = new FakeOpenShellCommandRunner([
      { exitCode: 0, stdout: 'openshell 0.0.63\n' },
      {
        exitCode: 0,
        stdout:
          'Server Status\n\n  Gateway: openshell\n  Server: https://127.0.0.1:17670\n  Status: Connected\n  Version: 0.0.63\n',
      },
      {
        exitCode: 0,
        stdout:
          'Gateway Info\n\n  Gateway: openshell\n  Gateway endpoint: https://127.0.0.1:17670\n',
      },
      { exitCode: 0, stdout: 'Download complete\n' },
    ]);
    const cli = new OpenShellCli({ runner });

    await expect(cli.version()).resolves.toBe('0.0.63');
    await expect(
      cli.status({
        gateway: 'a1-openshell',
        gatewayEndpoint: 'https://a1.example.com:17670',
      })
    ).resolves.toEqual({
      gateway: 'openshell',
      server: 'https://127.0.0.1:17670',
      status: 'connected',
      version: '0.0.63',
    });
    await expect(cli.gatewayInfo()).resolves.toEqual({
      gateway: 'openshell',
      endpoint: 'https://127.0.0.1:17670',
    });
    await expect(
      cli.downloadFile({
        destinationPath: '/tmp/events.jsonl',
        gateway: 'openshell',
        name: 'openkit-as-123',
        sandboxPath: '/sandbox/openkit/session/events.jsonl',
      })
    ).resolves.toEqual({
      stdout: 'Download complete\n',
    });
    expect(runner.calls).toEqual([
      ['--version'],
      ['status', '-g', 'a1-openshell', '--gateway-endpoint', 'https://a1.example.com:17670'],
      ['gateway', 'info'],
      [
        'sandbox',
        'download',
        '--gateway',
        'openshell',
        'openkit-as-123',
        '/sandbox/openkit/session/events.jsonl',
        '/tmp/events.jsonl',
      ],
    ]);
    expect(runner.options).toEqual([
      { timeoutMs: 30_000 },
      { timeoutMs: 30_000 },
      { timeoutMs: 30_000 },
      { timeoutMs: 120_000 },
    ]);
  });

  it('returns disconnected status when gateway status cannot connect', async () => {
    const runner = new FakeOpenShellCommandRunner([
      {
        exitCode: 1,
        stdout: 'Server Status\n\n  Gateway: openshell\n  Server: https://127.0.0.1:17670\n',
        stderr: 'Error: tcp connect error',
      },
    ]);
    const cli = new OpenShellCli({ runner });

    await expect(cli.status()).resolves.toEqual({
      gateway: 'openshell',
      server: 'https://127.0.0.1:17670',
      status: 'unavailable',
      version: null,
      error: 'Error: tcp connect error',
    });
  });

  it.each([
    ['true', true],
    ['false', false],
    ['<unset>', null],
  ])('strictly parses the global providers v2 setting %s', async (providersV2Setting, expected) => {
    const runner = new FakeOpenShellCommandRunner([
      {
        exitCode: 0,
        stdout: JSON.stringify({
          scope: 'global',
          settings: { providers_v2_enabled: providersV2Setting },
          settings_revision: 1,
        }),
      },
    ]);
    const cli = new OpenShellCli({ runner });

    await expect(
      cli.providersV2Enabled({
        gateway: 'a1-openshell',
        gatewayEndpoint: 'https://a1.example.com:54013',
      })
    ).resolves.toBe(expected);
    expect(runner.calls).toEqual([
      [
        'settings',
        'get',
        '--global',
        '--json',
        '-g',
        'a1-openshell',
        '--gateway-endpoint',
        'https://a1.example.com:54013',
      ],
    ]);
    expect(runner.options).toEqual([{ timeoutMs: 30_000 }]);
  });

  it.each([
    ['invalid JSON', 'not-json'],
    ['a missing setting', JSON.stringify({ scope: 'global', settings: {} })],
    [
      'a non-string setting',
      JSON.stringify({ scope: 'global', settings: { providers_v2_enabled: true } }),
    ],
  ])('fails closed for %s in global settings', async (_caseName, stdout) => {
    const runner = new FakeOpenShellCommandRunner([{ exitCode: 0, stdout }]);
    const cli = new OpenShellCli({ runner });

    await expect(cli.providersV2Enabled()).rejects.toThrow(/global settings|providers_v2_enabled/i);
  });

  it('reads metadata for an explicitly named gateway', async () => {
    const runner = new FakeOpenShellCommandRunner([
      {
        exitCode: 0,
        stdout:
          'Gateway Info\n\n  Gateway: a1-openshell\n  Gateway endpoint: https://a1.example.com:17670\n',
      },
    ]);
    const cli = new OpenShellCli({ runner });

    await expect(cli.gatewayInfo({ gateway: 'a1-openshell' })).resolves.toEqual({
      endpoint: 'https://a1.example.com:17670',
      gateway: 'a1-openshell',
    });
    expect(runner.calls).toEqual([['gateway', 'info', '-g', 'a1-openshell']]);
  });

  it('passes a direct remote gateway endpoint when reading gateway metadata', async () => {
    const runner = new FakeOpenShellCommandRunner([
      {
        exitCode: 0,
        stdout:
          'Gateway Info\n\n  Gateway: a1-openshell\n  Gateway endpoint: https://a1.example.com:54003\n',
      },
    ]);
    const cli = new OpenShellCli({ runner });

    await expect(
      cli.gatewayInfo({
        gateway: 'a1-openshell',
        gatewayEndpoint: 'https://a1.example.com:54003',
      })
    ).resolves.toEqual({
      endpoint: 'https://a1.example.com:54003',
      gateway: 'a1-openshell',
    });
    expect(runner.calls).toEqual([
      [
        'gateway',
        'info',
        '-g',
        'a1-openshell',
        '--gateway-endpoint',
        'https://a1.example.com:54003',
      ],
    ]);
  });

  it('upserts provider credentials through env lookup without putting values in argv', async () => {
    const runner = new FakeOpenShellCommandRunner([
      { exitCode: 1, stdout: '', stderr: 'provider not found' },
      { exitCode: 0, stdout: 'provider created\n' },
      { exitCode: 0, stdout: 'provider updated\n' },
    ]);
    const cli = new OpenShellCli({ runner });

    await expect(
      cli.upsertProvider({
        credentialExpiresAt: '2026-07-05T01:00:00.000Z',
        credentialKey: 'GITHUB_TOKEN',
        credentialValue: 'ghp_secret',
        gateway: 'openshell',
        name: 'provider_github_read',
        providerType: 'github_mcp',
      })
    ).resolves.toEqual({ name: 'provider_github_read' });
    expect(runner.calls).toEqual([
      ['provider', 'get', '--gateway', 'openshell', 'provider_github_read'],
      [
        'provider',
        'create',
        '--name',
        'provider_github_read',
        '--type',
        'github_mcp',
        '--credential',
        'GITHUB_TOKEN',
        '--gateway',
        'openshell',
      ],
      [
        'provider',
        'update',
        '--credential-expires-at',
        'GITHUB_TOKEN=2026-07-05T01:00:00.000Z',
        '--gateway',
        'openshell',
        'provider_github_read',
      ],
    ]);
    expect(runner.options).toEqual([
      { timeoutMs: 120_000 },
      { env: { GITHUB_TOKEN: 'ghp_secret' }, timeoutMs: 120_000 },
      { timeoutMs: 120_000 },
    ]);
    expect(JSON.stringify(runner.calls)).not.toContain('ghp_secret');
  });

  it('updates an existing provider only when its immutable type matches', async () => {
    const runner = new FakeOpenShellCommandRunner([
      {
        exitCode: 0,
        stdout: 'Provider\n\n  Name: worker-relay\n  Type: worker-inference-profile\n',
      },
      { exitCode: 0, stdout: 'provider updated\n' },
    ]);
    const cli = new OpenShellCli({ runner });

    await expect(
      cli.upsertProvider({
        credentialKey: 'OPENKIT_WORKER_INFERENCE_TOKEN',
        credentialValue: 'lease_binding_secret',
        gateway: 'openshell',
        name: 'worker-relay',
        providerType: 'worker-inference-profile',
      })
    ).resolves.toEqual({ name: 'worker-relay' });
    expect(runner.calls).toEqual([
      ['provider', 'get', '--gateway', 'openshell', 'worker-relay'],
      [
        'provider',
        'update',
        '--credential',
        'OPENKIT_WORKER_INFERENCE_TOKEN',
        '--gateway',
        'openshell',
        'worker-relay',
      ],
    ]);
  });

  it('fails closed when an existing provider has a different immutable type', async () => {
    const runner = new FakeOpenShellCommandRunner([
      {
        exitCode: 0,
        stdout: 'Provider\n\n  Name: worker-relay\n  Type: generic\n',
      },
    ]);
    const cli = new OpenShellCli({ runner });

    await expect(
      cli.upsertProvider({
        credentialKey: 'OPENKIT_WORKER_INFERENCE_TOKEN',
        credentialValue: 'lease_binding_secret',
        gateway: 'openshell',
        name: 'worker-relay',
        providerType: 'worker-inference-profile',
      })
    ).rejects.toThrow('provider type mismatch');
    expect(runner.calls).toEqual([['provider', 'get', '--gateway', 'openshell', 'worker-relay']]);
  });

  it('fails closed when provider inspection fails for a reason other than not found', async () => {
    const runner = new FakeOpenShellCommandRunner([
      { exitCode: 1, stdout: '', stderr: 'gateway authentication failed' },
    ]);
    const cli = new OpenShellCli({ runner });

    await expect(
      cli.upsertProvider({
        credentialKey: 'OPENKIT_WORKER_INFERENCE_TOKEN',
        credentialValue: 'lease_binding_secret',
        gateway: 'openshell',
        name: 'worker-relay',
        providerType: 'worker-inference-profile',
      })
    ).rejects.toThrow('provider inspection failed');
    expect(runner.calls).toEqual([['provider', 'get', '--gateway', 'openshell', 'worker-relay']]);
  });

  it('imports a missing immutable provider profile', async () => {
    const runner = new FakeOpenShellCommandRunner([
      { exitCode: 1, stdout: '', stderr: 'provider profile\n  │ not found' },
      { exitCode: 0, stdout: 'Imported 1 provider profile.\n' },
    ]);
    const cli = new OpenShellCli({ runner });
    const input = {
      gateway: 'openshell',
      id: workerInferenceProfile.id,
      path: workerInferenceProfilePath,
    };

    await expect(cli.ensureProviderProfile(input)).resolves.toEqual({ id: input.id });
    expect(runner.calls).toEqual([
      ['provider', 'profile', 'export', '--output', 'json', '--gateway', 'openshell', input.id],
      ['provider', 'profile', 'import', '--file', input.path, '--gateway', 'openshell'],
    ]);
    expect(runner.options).toEqual([{ timeoutMs: 120_000 }, { timeoutMs: 120_000 }]);
  });

  it('bounds retained sandbox creation so lifecycle recovery can regain ownership', async () => {
    const runner = new FakeOpenShellCommandRunner([{ exitCode: 0, stdout: 'sandbox created\n' }]);
    const cli = new OpenShellCli({ runner });

    await expect(
      cli.createSandbox({
        command: ['openkit-worker-shim', '--dry-run'],
        from: 'openkit/worker-codex:dev',
        name: 'openkit-as-timeout',
      })
    ).resolves.toMatchObject({ name: 'openkit-as-timeout' });
    expect(runner.options).toEqual([{ timeoutMs: 120_000 }]);
  });

  it('keeps an existing immutable provider profile only when content matches', async () => {
    const matchingRunner = new FakeOpenShellCommandRunner([
      {
        exitCode: 0,
        stdout: JSON.stringify({ ...workerInferenceProfile, resource_version: 1 }),
      },
    ]);
    const matchingCli = new OpenShellCli({ runner: matchingRunner });
    const input = {
      gateway: 'openshell',
      id: workerInferenceProfile.id,
      path: workerInferenceProfilePath,
    };

    await expect(matchingCli.ensureProviderProfile(input)).resolves.toEqual({ id: input.id });

    const mismatchedRunner = new FakeOpenShellCommandRunner([
      {
        exitCode: 0,
        stdout: JSON.stringify({
          ...workerInferenceProfile,
          endpoints: [{ ...workerInferenceProfile.endpoints[0], host: 'wrong.example.com' }],
          resource_version: 1,
        }),
      },
    ]);
    const mismatchedCli = new OpenShellCli({ runner: mismatchedRunner });

    await expect(mismatchedCli.ensureProviderProfile(input)).rejects.toThrow(
      'provider profile content collision'
    );
    expect(mismatchedRunner.calls).toHaveLength(1);
  });

  it('does not import a profile when export fails for a reason other than not found', async () => {
    const runner = new FakeOpenShellCommandRunner([
      { exitCode: 1, stdout: '', stderr: 'gateway authentication failed' },
    ]);
    const cli = new OpenShellCli({ runner });

    await expect(
      cli.ensureProviderProfile({
        gateway: 'openshell',
        id: workerInferenceProfile.id,
        path: workerInferenceProfilePath,
      })
    ).rejects.toThrow('provider profile export failed');
    expect(runner.calls).toHaveLength(1);
  });

  it('accepts an identical immutable profile imported concurrently', async () => {
    const runner = new FakeOpenShellCommandRunner([
      { exitCode: 1, stdout: '', stderr: 'provider profile\n  │ not found' },
      { exitCode: 1, stdout: '', stderr: 'provider profile already exists' },
      {
        exitCode: 0,
        stdout: JSON.stringify({ ...workerInferenceProfile, resource_version: 1 }),
      },
    ]);
    const cli = new OpenShellCli({ runner });

    await expect(
      cli.ensureProviderProfile({
        gateway: 'openshell',
        id: workerInferenceProfile.id,
        path: workerInferenceProfilePath,
      })
    ).resolves.toEqual({ id: workerInferenceProfile.id });
    expect(runner.calls.map((call) => call.slice(0, 4))).toEqual([
      ['provider', 'profile', 'export', '--output'],
      ['provider', 'profile', 'import', '--file'],
      ['provider', 'profile', 'export', '--output'],
    ]);
  });

  it('reads provider details without returning credential-looking values', async () => {
    const runner = new FakeOpenShellCommandRunner([
      {
        exitCode: 0,
        stdout:
          'Provider\n\n  Name: provider_github_read\n  Credential: ghp_secret_value\n  API Key = sk-secret-value\n',
      },
    ]);
    const cli = new OpenShellCli({ runner });

    const provider = await cli.getProvider({
      gateway: 'openshell',
      name: 'provider_github_read',
    });

    expect(provider).toEqual({
      name: 'provider_github_read',
      stdout: expect.stringContaining('provider_github_read'),
    });
    expect(runner.calls).toEqual([
      ['provider', 'get', '--gateway', 'openshell', 'provider_github_read'],
    ]);
    expect(runner.options).toEqual([{ timeoutMs: 30_000 }]);
    expect(provider.stdout).not.toContain('ghp_secret_value');
    expect(provider.stdout).not.toContain('sk-secret-value');
  });

  it('reads provider refresh status without returning credential-looking values', async () => {
    const runner = new FakeOpenShellCommandRunner([
      {
        exitCode: 0,
        stdout:
          'Refresh Status\n\n  Provider: provider_github_read\n  Credential: ghp_secret_value\n  Refresh token: sk-secret-value\n',
      },
    ]);
    const cli = new OpenShellCli({ runner });

    const status = await cli.getProviderRefreshStatus({
      credentialKey: 'GITHUB_TOKEN',
      gateway: 'openshell',
      name: 'provider_github_read',
    });

    expect(status).toEqual({
      name: 'provider_github_read',
      stdout: expect.stringContaining('provider_github_read'),
    });
    expect(runner.calls).toEqual([
      [
        'provider',
        'refresh',
        'status',
        '--gateway',
        'openshell',
        '--credential-key',
        'GITHUB_TOKEN',
        'provider_github_read',
      ],
    ]);
    expect(runner.options).toEqual([{ timeoutMs: 30_000 }]);
    expect(status.stdout).not.toContain('ghp_secret_value');
    expect(status.stdout).not.toContain('sk-secret-value');
  });
});

describe('compileOpenShellSandboxCreateArgs', () => {
  it('compiles a single-process OpenKit worker sandbox create command', () => {
    expect(
      compileOpenShellSandboxCreateArgs({
        command: ['openkit-worker-shim', '--package', '/openkit/config/package.json'],
        cpu: '2',
        env: {
          OPENKIT_CONTROL_BASE_URL: 'https://nanocore.example/api/worker-control',
          OPENKIT_SESSION_DIR: '/openkit/session',
        },
        from: 'ghcr.io/openkit/codex-worker:test',
        gateway: 'openshell',
        gatewayEndpoint: 'https://a1.example.com:54003',
        labels: {
          'openkit.agentSessionId': 'as_123',
          'openkit.packageSnapshotId': 'aepsnap_123',
        },
        memory: '4Gi',
        name: 'openkit-as-123',
        noKeep: false,
        policyPath: '/private/tmp/openkit-policy.yml',
        providers: ['openai'],
        uploads: [
          {
            sourcePath: '/private/tmp/package.json',
            targetPath: '/openkit/config/package.json',
          },
        ],
      })
    ).toEqual([
      'sandbox',
      'create',
      '--name',
      'openkit-as-123',
      '--from',
      'ghcr.io/openkit/codex-worker:test',
      '--gateway',
      'openshell',
      '--gateway-endpoint',
      'https://a1.example.com:54003',
      '--policy',
      '/private/tmp/openkit-policy.yml',
      '--cpu',
      '2',
      '--memory',
      '4Gi',
      '--provider',
      'openai',
      '--upload',
      '/private/tmp/package.json:/openkit/config/package.json',
      '--label',
      'openkit.agentSessionId=as_123',
      '--label',
      'openkit.packageSnapshotId=aepsnap_123',
      '--env',
      'OPENKIT_CONTROL_BASE_URL=https://nanocore.example/api/worker-control',
      '--env',
      'OPENKIT_SESSION_DIR=/openkit/session',
      '--',
      'openkit-worker-shim',
      '--package',
      '/openkit/config/package.json',
    ]);
  });
});

describe('OpenShell sandbox exec', () => {
  it('compiles the pinned retained-sandbox execution command', () => {
    expect(
      compileOpenShellSandboxExecArgs({
        command: ['openkit-worker-shim', '--package', '/openkit/config/package.json'],
        env: {
          OPENKIT_CONTROL_TOKEN: 'lease-token',
          OPENKIT_SESSION_DIR: '/openkit/session',
        },
        gateway: 'openshell',
        gatewayEndpoint: 'https://a1.example.com:54003',
        name: 'openkit-as-123',
        timeoutSeconds: 300,
        workdir: '/workspace',
      })
    ).toEqual([
      'sandbox',
      'exec',
      '--name',
      'openkit-as-123',
      '--no-tty',
      '--gateway',
      'openshell',
      '--gateway-endpoint',
      'https://a1.example.com:54003',
      '--workdir',
      '/workspace',
      '--timeout',
      '300',
      '--env',
      'OPENKIT_CONTROL_TOKEN=lease-token',
      '--env',
      'OPENKIT_SESSION_DIR=/openkit/session',
      '--',
      'openkit-worker-shim',
      '--package',
      '/openkit/config/package.json',
    ]);
  });

  it('returns the worker command result and propagates a non-zero exit code', async () => {
    const runner = new FakeOpenShellCommandRunner([
      { exitCode: 0, stdout: 'worker completed\n' },
      { exitCode: 17, stdout: '', stderr: 'worker failed\n' },
    ]);
    const cli = new OpenShellCli({ runner });
    const input = {
      command: ['openkit-worker-shim', '--package', '/openkit/config/package.json'],
      name: 'openkit-as-123',
    };

    await expect(cli.execSandbox(input)).resolves.toEqual({
      exitCode: 0,
      stderr: '',
      stdout: 'worker completed\n',
    });
    await expect(cli.execSandbox(input)).rejects.toThrow(
      'OpenShell sandbox exec failed with exit code 17: worker failed'
    );
    expect(runner.options).toEqual([{ timeoutMs: 905_000 }, { timeoutMs: 905_000 }]);
  });
});
