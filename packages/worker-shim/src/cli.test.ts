import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type CodexProcessRunner,
  parseCodexShimArgs,
  parseWorkerSidecarArgs,
  runCodexShim,
  runWorkerSidecar,
  type WorkerSidecarCommandRunner,
  type WorkerSidecarEnvironment,
} from './cli.js';
import type { WorkerControlRelayFetch } from './control-client.js';

describe('worker shim CLI parsing', () => {
  it('parses Codex shim arguments', () => {
    expect(
      parseCodexShimArgs([
        '--package',
        '/openkit/config/package.json',
        '--session-dir',
        '/openkit/session',
        '--artifact-dir',
        '/openkit/artifacts',
        '--dry-run',
      ])
    ).toEqual({
      artifactDir: '/openkit/artifacts',
      dryRun: true,
      packagePath: '/openkit/config/package.json',
      sessionDir: '/openkit/session',
    });
  });

  it('parses worker sidecar arguments', () => {
    expect(
      parseWorkerSidecarArgs([
        '--control-base-url',
        'https://control.local/v1/worker-control',
        '--relay-upstream',
        'https://nanocore.local/api/worker-control',
        '--session-dir',
        '/openkit/session',
        '--once',
      ])
    ).toEqual({
      controlBaseUrl: 'https://control.local/v1/worker-control',
      once: true,
      relayUpstream: 'https://nanocore.local/api/worker-control',
      sessionDir: '/openkit/session',
    });
  });

  it('rejects missing required arguments with product-safe errors', () => {
    expect(() => parseCodexShimArgs(['--session-dir', '/openkit/session'])).toThrow(
      'Missing required --package argument.'
    );
    expect(() => parseWorkerSidecarArgs(['--session-dir', '/openkit/session'])).toThrow(
      'Missing required --control-base-url argument.'
    );
  });

  it('runs one sidecar relay cycle from sandbox environment variables', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-sidecar-relay-'));
    const requests: Array<{ body: unknown; headers: Record<string, string>; url: string }> = [];
    const fetch: WorkerControlRelayFetch = async (url, init) => {
      requests.push({
        body: JSON.parse(String(init.body)) as unknown,
        headers: Object.fromEntries(
          Object.entries(init.headers).map(([key, value]) => [key.toLowerCase(), value])
        ),
        url,
      });

      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(url.endsWith('/commands/poll') ? { commands: [] } : {}),
      };
    };

    await runWorkerSidecar({
      args: parseWorkerSidecarArgs([
        '--control-base-url',
        'https://control.local/v1/worker-control',
        '--relay-upstream',
        'https://nanocore.local/api/worker-control',
        '--session-dir',
        sessionDir,
        '--once',
      ]),
      environment: workerSidecarEnvironment(),
      fetch,
    });

    expect(requests).toEqual([
      expect.objectContaining({
        body: expect.objectContaining({
          lineage: expect.objectContaining({
            agentSessionId: 'as_sidecar_1',
            packageSnapshotId: 'pkg_sidecar_1',
            requestId: 'req_sidecar_1',
            threadId: 'th_sidecar',
            turnId: 'turn_sidecar',
            workspaceId: 'ws_sidecar',
          }),
          sequence: 0,
          status: 'starting',
        }),
        headers: expect.objectContaining({ authorization: 'Bearer token_sidecar_1' }),
        url: 'https://nanocore.local/api/worker-control/heartbeat',
      }),
      expect.objectContaining({
        body: expect.objectContaining({
          lineage: expect.objectContaining({ packageSnapshotId: 'pkg_sidecar_1' }),
        }),
        url: 'https://nanocore.local/api/worker-control/commands/poll',
      }),
    ]);
    expect(readJsonl(join(sessionDir, 'events.jsonl'))).toEqual([
      expect.objectContaining({
        event: {
          data: {
            status: 'starting',
          },
          type: 'worker.heartbeat',
        },
        kind: 'event',
        sequence: 0,
      }),
    ]);
  });

  it('executes terminal commands returned by NanoCore and reports terminal results', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-sidecar-terminal-'));
    const runner = new FakeSidecarCommandRunner({
      durationMs: 4,
      exitCode: 0,
      stderr: '',
      stdout: '/workspace/openkit\n',
    });
    const requests: Array<{ body: unknown; headers: Record<string, string>; url: string }> = [];
    const fetch: WorkerControlRelayFetch = async (url, init) => {
      requests.push({
        body: JSON.parse(String(init.body)) as unknown,
        headers: Object.fromEntries(
          Object.entries(init.headers).map(([key, value]) => [key.toLowerCase(), value])
        ),
        url,
      });

      if (url.endsWith('/commands/poll')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              commands: [
                {
                  argv: ['pwd'],
                  commandId: 'term_sidecar_1',
                  cwd: '/workspace/openkit',
                  kind: 'terminal-command',
                },
                {
                  approvalRequestId: 'approval_sidecar_1',
                  commandId: 'approval_command_1',
                  decision: 'granted',
                  kind: 'approval-result',
                },
              ],
            }),
        };
      }

      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({}),
      };
    };

    await runWorkerSidecar({
      args: parseWorkerSidecarArgs([
        '--control-base-url',
        'https://control.local/v1/worker-control',
        '--relay-upstream',
        'https://nanocore.local/api/worker-control',
        '--session-dir',
        sessionDir,
        '--once',
      ]),
      commandRunner: runner,
      environment: workerSidecarEnvironment(),
      fetch,
    });

    expect(runner.calls).toEqual([
      expect.objectContaining({
        argv: ['pwd'],
        cwd: '/workspace/openkit',
      }),
    ]);
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          body: expect.objectContaining({
            exitCode: 0,
            stdout: '/workspace/openkit\n',
            terminalCommandId: 'term_sidecar_1',
          }),
          url: 'https://nanocore.local/api/worker-control/terminal-results',
        }),
      ])
    );
    expect(readJsonl(join(sessionDir, 'events.jsonl'))).toEqual([
      expect.objectContaining({
        event: {
          data: {
            status: 'starting',
          },
          type: 'worker.heartbeat',
        },
        sequence: 0,
      }),
      expect.objectContaining({
        event: {
          data: {
            approvalRequestId: 'approval_sidecar_1',
            decision: 'granted',
            status: 'command.approval_result',
          },
          type: 'worker.heartbeat',
        },
        sequence: 1,
      }),
      expect.objectContaining({
        event: {
          data: {
            commandId: 'term_sidecar_1',
            exitCode: 0,
            status: 'command.terminal_result',
          },
          type: 'worker.heartbeat',
        },
        sequence: 2,
      }),
    ]);
  });

  it('supervises a configured Codex process and writes transcript lifecycle records', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-shim-session-'));
    const packagePath = join(sessionDir, 'package.json');
    const finalMessagePath = join(sessionDir, 'final-message.txt');
    const runner = new FakeCodexProcessRunner(
      {
        exitCode: 0,
        signal: null,
        stderr: '',
        stdout: '{"type":"session.completed"}\n',
      },
      () => {
        writeFileSync(finalMessagePath, 'Codex worker completed the task.\n', 'utf8');
      }
    );
    writeFileSync(
      packagePath,
      JSON.stringify({
        extensions: {
          openkit: {
            codexCommand: [
              'codex',
              'exec',
              '--json',
              '--output-last-message',
              finalMessagePath,
              'Summarize the repository.',
            ],
            resultMessagePath: finalMessagePath,
          },
        },
        runtime: {
          command: {
            workingDirectory: '/workspace/openkit',
          },
        },
      }),
      'utf8'
    );

    await expect(
      runCodexShim({
        args: parseCodexShimArgs([
          '--package',
          packagePath,
          '--session-dir',
          sessionDir,
          '--artifact-dir',
          join(sessionDir, 'artifacts'),
        ]),
        environment: codexShimEnvironment(),
        runner,
      })
    ).resolves.toEqual({
      exitCode: 0,
      signal: null,
      status: 'completed',
    });

    expect(runner.calls).toEqual([
      expect.objectContaining({
        argv: [
          'codex',
          'exec',
          '--json',
          '--output-last-message',
          finalMessagePath,
          'Summarize the repository.',
        ],
        cwd: '/workspace/openkit',
      }),
    ]);
    expect(readJsonl(join(sessionDir, 'events.jsonl'))).toEqual([
      expect.objectContaining({
        event: {
          data: {
            argv: [
              'codex',
              'exec',
              '--json',
              '--output-last-message',
              finalMessagePath,
              'Summarize the repository.',
            ],
            cwd: '/workspace/openkit',
            runtime: 'codex',
          },
          type: 'worker.ready',
        },
        kind: 'event',
        sequence: 0,
      }),
      expect.objectContaining({
        event: {
          data: {
            exitCode: 0,
            runtime: 'codex',
            signal: null,
            status: 'process.exited',
          },
          type: 'worker.heartbeat',
        },
        kind: 'event',
        sequence: 1,
      }),
      expect.objectContaining({
        event: {
          data: {
            status: 'completed',
          },
          type: 'turn.completed',
        },
        kind: 'event',
        sequence: 2,
      }),
    ]);
    expect(readJsonl(join(sessionDir, 'items.jsonl'))).toEqual([
      expect.objectContaining({
        item: {
          status: 'completed',
          text: 'Codex worker completed the task.',
          type: 'assistant-message',
        },
        kind: 'item',
        sequence: 3,
      }),
    ]);
  });

  it('materializes catalog-resolved Skill and MCP supply before Codex runs', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-shim-supply-'));
    const packagePath = join(sessionDir, 'package.json');
    const skillTargetPath = join(sessionDir, 'skills', 'repo-guidelines');
    const mcpTargetPath = join(sessionDir, 'mcp', 'github.json');
    const runner = new FakeCodexProcessRunner(
      {
        exitCode: 0,
        signal: null,
        stderr: '',
        stdout: '{"type":"session.completed"}\n',
      },
      () => {
        expect(readFileSync(join(skillTargetPath, 'openkit-supply.json'), 'utf8')).toContain(
          'repo-guidelines'
        );
        expect(readFileSync(mcpTargetPath, 'utf8')).toContain('github-mcp-server');
      }
    );
    writeFileSync(
      packagePath,
      JSON.stringify({
        extensions: {
          openkit: {
            codexCommand: ['codex', 'exec', 'Summarize the repository.'],
          },
        },
        runtime: {
          command: {
            workingDirectory: '/workspace/openkit',
          },
        },
        supply: {
          skills: [
            {
              id: 'repo-guidelines',
              version: '1.0.0',
              sourceRef: 'server:skills/repo-guidelines',
              integrity: { sha256: 'sha256-repo-guidelines-v1' },
              materialization: {
                kind: 'filesystem-copy',
                targetPath: skillTargetPath,
              },
              reviewStatus: 'approved',
              secretRefIds: [],
            },
          ],
          mcpServers: [
            {
              id: 'github',
              version: '1.0.0',
              sourceRef: 'server:mcp/github',
              transport: 'stdio',
              command: ['github-mcp-server'],
              allowedTools: ['repos.get'],
              materialization: {
                kind: 'generated-config',
                targetPath: mcpTargetPath,
              },
              providerInstanceIds: ['provider_github_read'],
              vaultGrantIds: ['grant_github_read'],
              secretRefIds: ['vault_github_read'],
              token: 'GITHUB_TOKEN',
            },
          ],
        },
      }),
      'utf8'
    );

    await expect(
      runCodexShim({
        args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: codexShimEnvironment(),
        runner,
      })
    ).resolves.toMatchObject({ status: 'completed' });

    const skillMetadata = readFileSync(join(skillTargetPath, 'openkit-supply.json'), 'utf8');
    const mcpConfig = readFileSync(mcpTargetPath, 'utf8');
    expect(skillMetadata).toContain('sha256-repo-guidelines-v1');
    expect(mcpConfig).toContain('vault_github_read');
    expect(mcpConfig).not.toContain('GITHUB_TOKEN');
  });

  it('writes a git workspace change manifest after a successful Codex process', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-shim-workspace-'));
    const repoDir = join(sessionDir, 'repo');
    const packagePath = join(sessionDir, 'package.json');
    const finalMessagePath = join(sessionDir, 'final-message.txt');
    mkdirSync(repoDir);
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'worker@example.com'], {
      cwd: repoDir,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'user.name', 'Worker'], { cwd: repoDir, stdio: 'ignore' });
    writeFileSync(join(repoDir, 'README.md'), '# Demo\n', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoDir, stdio: 'ignore' });
    const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoDir,
      encoding: 'utf8',
    }).trim();
    const runner = new FakeCodexProcessRunner(
      {
        exitCode: 0,
        signal: null,
        stderr: '',
        stdout: '',
      },
      () => {
        mkdirSync(join(repoDir, 'temp', 'research'), { recursive: true });
        writeFileSync(join(repoDir, 'README.md'), '# Demo\n\nUpdated by worker.\n', 'utf8');
        writeFileSync(
          join(repoDir, 'temp', 'research', 'worker-report.md'),
          '# Worker Report\n',
          'utf8'
        );
        writeFileSync(finalMessagePath, 'Updated the repository.\n', 'utf8');
      }
    );
    writeFileSync(
      packagePath,
      JSON.stringify({
        runtime: {
          command: {
            workingDirectory: repoDir,
          },
        },
        workspace: {
          root: repoDir,
          inputs: [
            {
              access: 'read-write',
              id: 'repo',
              kind: 'directory',
              materialization: {
                changeSetManifestPath: '/openkit/session/workspace-changes.json',
                strategy: 'git',
              },
              source: { kind: 'host-dir', pathRef: 'workspace-root://repo' },
              target: repoDir,
            },
          ],
        },
      }),
      'utf8'
    );

    await runCodexShim({
      args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
      environment: codexShimEnvironment(),
      runner,
    });

    const manifest = JSON.parse(readFileSync(join(sessionDir, 'workspace-changes.json'), 'utf8'));
    const patch = readFileSync(join(sessionDir, 'workspace.patch'), 'utf8');

    expect(manifest).toMatchObject({
      base: { commit: baseCommit, contentDigest: null },
      changedPaths: [
        { binary: false, path: 'README.md', status: 'modified' },
        { binary: false, path: 'temp/research/worker-report.md', status: 'added' },
      ],
      inputSnapshotId: 'wis_pkg_codex_1_repo',
      materializationRecordId: 'wmr_pkg_codex_1_repo',
      patch: {
        bytes: expect.any(Number),
        digest: expect.stringMatching(/^sha256:/),
        ref: 'worker-session://workspace.patch',
      },
      resourceId: 'repo',
      strategy: 'git',
      workspaceId: 'ws_codex',
    });
    expect(patch.endsWith('\n')).toBe(true);
  });

  it('uses OPENKIT_CODEX_COMMAND and records failed Codex exits', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'openkit-codex-shim-failed-'));
    const packagePath = join(sessionDir, 'package.json');
    const runner = new FakeCodexProcessRunner({
      exitCode: 7,
      signal: null,
      stderr: 'failed with token=tok_live and Authorization: Bearer live_secret\n',
      stdout: 'stdout mentions sk-openkit-secret\n',
    });
    writeFileSync(
      packagePath,
      JSON.stringify({
        runtime: {
          command: {
            workingDirectory: '/workspace/openkit',
          },
        },
      }),
      'utf8'
    );

    await expect(
      runCodexShim({
        args: parseCodexShimArgs(['--package', packagePath, '--session-dir', sessionDir]),
        environment: {
          ...codexShimEnvironment(),
          OPENKIT_CODEX_COMMAND: '["codex","--bad-flag"]',
        },
        runner,
      })
    ).resolves.toEqual({
      exitCode: 7,
      signal: null,
      status: 'failed',
    });

    expect(runner.calls[0]?.argv).toEqual(['codex', '--bad-flag']);
    expect(readJsonl(join(sessionDir, 'events.jsonl')).at(-1)).toEqual(
      expect.objectContaining({
        event: {
          data: {
            diagnostics: {
              stderr: 'failed with token=[redacted] and Authorization: Bearer [redacted]',
              stdout: 'stdout mentions [redacted]',
            },
            reason: 'Codex process exited with code 7.',
            status: 'failed',
          },
          type: 'turn.failed',
        },
      })
    );
    expect(readFileSync(join(sessionDir, 'events.jsonl'), 'utf8')).not.toContain(
      'sk-openkit-secret'
    );
    expect(readFileSync(join(sessionDir, 'events.jsonl'), 'utf8')).not.toContain('tok_live');
    expect(readFileSync(join(sessionDir, 'events.jsonl'), 'utf8')).not.toContain('live_secret');
  });
});

class FakeCodexProcessRunner implements CodexProcessRunner {
  public readonly calls: Array<{ argv: string[]; cwd: string; env: Record<string, string> }> = [];

  private readonly result: Awaited<ReturnType<CodexProcessRunner['run']>>;

  private readonly onRun: (() => void) | null;

  public constructor(
    result: Awaited<ReturnType<CodexProcessRunner['run']>>,
    onRun: (() => void) | null = null
  ) {
    this.result = result;
    this.onRun = onRun;
  }

  public async run(input: {
    argv: string[];
    cwd: string;
    env: Record<string, string>;
  }): Promise<Awaited<ReturnType<CodexProcessRunner['run']>>> {
    this.calls.push(input);
    this.onRun?.();

    return this.result;
  }
}

class FakeSidecarCommandRunner implements WorkerSidecarCommandRunner {
  public readonly calls: Array<{
    argv: string[];
    cwd: string | null;
    env: Record<string, string>;
  }> = [];

  private readonly result: Awaited<ReturnType<WorkerSidecarCommandRunner['run']>>;

  public constructor(result: Awaited<ReturnType<WorkerSidecarCommandRunner['run']>>) {
    this.result = result;
  }

  public async run(input: {
    argv: string[];
    cwd: string | null;
    env: Record<string, string>;
  }): Promise<Awaited<ReturnType<WorkerSidecarCommandRunner['run']>>> {
    this.calls.push(input);

    return this.result;
  }
}

/**
 * Creates a sandbox environment fixture for sidecar relay tests.
 *
 * @returns Worker sidecar environment variables.
 */
function workerSidecarEnvironment(): WorkerSidecarEnvironment {
  return {
    OPENKIT_AGENT_SESSION_ID: 'as_sidecar_1',
    OPENKIT_CONTROL_TOKEN: 'token_sidecar_1',
    OPENKIT_PACKAGE_SNAPSHOT_ID: 'pkg_sidecar_1',
    OPENKIT_REQUEST_ID: 'req_sidecar_1',
    OPENKIT_THREAD_ID: 'th_sidecar',
    OPENKIT_TURN_ID: 'turn_sidecar',
    OPENKIT_WORKSPACE_ID: 'ws_sidecar',
  };
}

/**
 * Creates a sandbox environment fixture for Codex supervision tests.
 *
 * @returns Worker sidecar environment variables plus Codex command configuration.
 */
function codexShimEnvironment(): WorkerSidecarEnvironment & { OPENKIT_CODEX_COMMAND?: string } {
  return {
    OPENKIT_AGENT_SESSION_ID: 'as_codex_1',
    OPENKIT_CONTROL_TOKEN: 'token_codex_1',
    OPENKIT_PACKAGE_SNAPSHOT_ID: 'pkg_codex_1',
    OPENKIT_REQUEST_ID: 'req_codex_1',
    OPENKIT_THREAD_ID: 'th_codex',
    OPENKIT_TURN_ID: 'turn_codex',
    OPENKIT_WORKSPACE_ID: 'ws_codex',
  };
}

/**
 * Reads JSONL records from a transcript file.
 *
 * @param path Transcript file path.
 * @returns Parsed JSONL records.
 */
function readJsonl(path: string): unknown[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}
