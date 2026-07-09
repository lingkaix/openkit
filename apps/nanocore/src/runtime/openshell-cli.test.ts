import { describe, expect, it } from 'vitest';
import {
  compileOpenShellSandboxCreateArgs,
  OpenShellCli,
  type OpenShellCommandRunner,
} from './openshell-cli.js';

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
  it('parses version, status, gateway, and doctor output from the real CLI shape', async () => {
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
      {
        exitCode: 0,
        stdout:
          'Checking system prerequisites...\n\n  Docker ............. ok (version 29.4.0)\n  DOCKER_HOST ........ (not set, using default socket)\n\nAll checks passed.\n',
      },
      { exitCode: 0, stdout: 'Download complete\n' },
      { exitCode: 0, stdout: 'Detached provider_github_read from openkit-as-123\n' },
      { exitCode: 0, stdout: 'Deleted sandbox openkit-as-123\n' },
    ]);
    const cli = new OpenShellCli({ runner });

    await expect(cli.version()).resolves.toBe('0.0.63');
    await expect(cli.status()).resolves.toEqual({
      gateway: 'openshell',
      server: 'https://127.0.0.1:17670',
      status: 'connected',
      version: '0.0.63',
    });
    await expect(cli.gatewayInfo()).resolves.toEqual({
      gateway: 'openshell',
      endpoint: 'https://127.0.0.1:17670',
    });
    await expect(cli.doctorCheck()).resolves.toEqual({
      ok: true,
      docker: 'ok (version 29.4.0)',
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
    await expect(
      cli.detachProvider({
        gateway: 'openshell',
        name: 'openkit-as-123',
        provider: 'provider_github_read',
      })
    ).resolves.toEqual({
      stdout: 'Detached provider_github_read from openkit-as-123\n',
    });
    await expect(
      cli.deleteSandbox({
        gateway: 'openshell',
        name: 'openkit-as-123',
      })
    ).resolves.toEqual({
      stdout: 'Deleted sandbox openkit-as-123\n',
    });
    expect(runner.calls).toEqual([
      ['--version'],
      ['status'],
      ['gateway', 'info'],
      ['doctor', 'check'],
      [
        'sandbox',
        'download',
        '--gateway',
        'openshell',
        'openkit-as-123',
        '/sandbox/openkit/session/events.jsonl',
        '/tmp/events.jsonl',
      ],
      [
        'sandbox',
        'provider',
        'detach',
        '--gateway',
        'openshell',
        'openkit-as-123',
        'provider_github_read',
      ],
      ['sandbox', 'delete', '--gateway', 'openshell', 'openkit-as-123'],
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
        gatewayInsecure: true,
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
        '--gateway-insecure',
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
    expect(runner.options).toEqual([undefined, { env: { GITHUB_TOKEN: 'ghp_secret' } }, undefined]);
    expect(JSON.stringify(runner.calls)).not.toContain('ghp_secret');
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
    expect(status.stdout).not.toContain('ghp_secret_value');
    expect(status.stdout).not.toContain('sk-secret-value');
  });
});

describe('compileOpenShellSandboxCreateArgs', () => {
  it('compiles a no-fork OpenKit sidecar sandbox create command', () => {
    expect(
      compileOpenShellSandboxCreateArgs({
        command: ['openkit-codex-shim', '--package', '/openkit/config/package.json'],
        cpu: '2',
        env: {
          OPENKIT_CONTROL_BASE_URL: 'https://control.local/v1/worker-control',
          OPENKIT_SESSION_DIR: '/openkit/session',
        },
        from: 'ghcr.io/openkit/codex-worker:test',
        gateway: 'openshell',
        gatewayEndpoint: 'https://a1.example.com:54003',
        gatewayInsecure: true,
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
      '--gateway-insecure',
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
      'OPENKIT_CONTROL_BASE_URL=https://control.local/v1/worker-control',
      '--env',
      'OPENKIT_SESSION_DIR=/openkit/session',
      '--',
      'openkit-codex-shim',
      '--package',
      '/openkit/config/package.json',
    ]);
  });
});
