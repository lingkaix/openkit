// openkit-test-platform: posix
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { resolveWorkspaceMcpServer } from '@openkit/config-schema';
import { describe, expect, it, vi } from 'vitest';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createMcpHttpStub } from '../test-support/mcp-http-stub.js';
import { mcpToolSchemaContentDigest } from './mcp-tool-schema-snapshots.js';
import { createDefaultWorkerMcpGateway } from './worker-mcp-gateway.js';

describe('worker MCP gateway', () => {
  it('canonicalizes tool order and nested schema keys for snapshot identity', () => {
    const first = [
      { name: 'é', inputSchema: { é: true, é: false } },
      { name: 'é', inputSchema: { é: false, é: true } },
      { name: 'zeta', inputSchema: { type: 'object', properties: { z: { type: 'string' } } } },
      {
        name: 'alpha',
        inputSchema: {
          required: ['value'],
          properties: { value: { minLength: 1, type: 'string' } },
          type: 'object',
        },
      },
    ];
    const reordered = [
      { name: 'é', inputSchema: { é: true, é: false } },
      { name: 'é', inputSchema: { é: false, é: true } },
      {
        name: 'alpha',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string', minLength: 1 } },
          required: ['value'],
        },
      },
      { name: 'zeta', inputSchema: { properties: { z: { type: 'string' } }, type: 'object' } },
    ];

    expect(mcpToolSchemaContentDigest(first)).toBe(mcpToolSchemaContentDigest(reordered));
  });

  it('uses one SDK-managed stdio session for live schemas and tool calls', async () => {
    vi.useFakeTimers({ toFake: ['clearTimeout', 'setTimeout'] });
    const ping = vi.spyOn(Client.prototype, 'ping').mockResolvedValue({});
    const gateway = createDefaultWorkerMcpGateway();
    const server = resolveWorkspaceMcpServer({
      catalog: {
        schemaVersion: 1,
        servers: [
          {
            allowedTools: ['echo'],
            approvalRequiredTools: [],
            credentialBindings: [],
            deniedTools: [],
            enabled: true,
            id: 'echo',
            pinnedSchemaSnapshotId: null,
            schemaPolicy: 'tracking',
            timeoutMs: 2_000,
            transport: {
              args: [fileURLToPath(new URL('../test-support/mcp-stdio-stub.mjs', import.meta.url))],
              command: process.execPath,
              environment: {},
              kind: 'stdio',
            },
          },
        ],
      },
      serverId: 'echo',
    });

    try {
      await expect(gateway.listTools({ server, workspaceId: 'ws_demo' })).resolves.toMatchObject({
        serverVersion: '1.0.0',
        tools: [{ name: 'echo' }],
      });
      const first = await gateway.callTool({
        arguments: { message: 'first' },
        server,
        toolName: 'echo',
        workspaceId: 'ws_demo',
      });
      const second = await gateway.callTool({
        arguments: { message: 'second' },
        server,
        toolName: 'echo',
        workspaceId: 'ws_demo',
      });

      expect(first.structuredContent).toMatchObject({ message: 'first' });
      expect(second.structuredContent).toMatchObject({
        message: 'second',
        pid: (first.structuredContent as { pid: number }).pid,
      });
      expect(gateway.getServerHealth({ server, workspaceId: 'ws_demo' })).toBe('ready');
      for (let elapsed = 0; elapsed < 60_000; elapsed += 15_000) {
        await vi.advanceTimersByTimeAsync(15_000);
        for (let attempt = 0; attempt < 10; attempt += 1) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
      await vi.advanceTimersByTimeAsync(5_000);
      expect(gateway.getServerHealth({ server, workspaceId: 'ws_demo' })).toBe('inactive');
    } finally {
      await gateway.close();
      ping.mockRestore();
      vi.useRealTimers();
    }
  });

  it('degrades a cached stdio session when its health check observes child exit', async () => {
    const gateway = createDefaultWorkerMcpGateway();
    const server = resolveWorkspaceMcpServer({
      catalog: {
        schemaVersion: 1,
        servers: [
          {
            allowedTools: ['echo'],
            approvalRequiredTools: [],
            credentialBindings: [],
            deniedTools: [],
            enabled: true,
            id: 'echo',
            pinnedSchemaSnapshotId: null,
            schemaPolicy: 'tracking',
            timeoutMs: 2_000,
            transport: {
              args: [fileURLToPath(new URL('../test-support/mcp-stdio-stub.mjs', import.meta.url))],
              command: process.execPath,
              environment: {},
              kind: 'stdio',
            },
          },
        ],
      },
      serverId: 'echo',
    });

    try {
      const result = await gateway.callTool({
        arguments: { message: 'pid' },
        server,
        toolName: 'echo',
        workspaceId: 'ws_demo',
      });
      const pid = (result.structuredContent as { pid: number }).pid;
      expect(gateway.getServerHealth({ server, workspaceId: 'ws_demo' })).toBe('ready');

      process.kill(pid, 'SIGTERM');
      await vi.waitFor(
        () => {
          expect(gateway.getServerHealth({ server, workspaceId: 'ws_demo' })).toBe('degraded');
        },
        { timeout: 2_000 }
      );
    } finally {
      await gateway.close();
    }
  });

  it('classifies bounded result, crash, and tool-error effects', async () => {
    const gateway = createDefaultWorkerMcpGateway();
    const server = resolveWorkspaceMcpServer({
      catalog: {
        schemaVersion: 1,
        servers: [
          {
            allowedTools: ['echo'],
            approvalRequiredTools: [],
            credentialBindings: [],
            deniedTools: [],
            enabled: true,
            id: 'echo',
            pinnedSchemaSnapshotId: null,
            schemaPolicy: 'tracking',
            timeoutMs: 5_000,
            transport: {
              args: [fileURLToPath(new URL('../test-support/mcp-stdio-stub.mjs', import.meta.url))],
              command: process.execPath,
              environment: {},
              kind: 'stdio',
            },
          },
        ],
      },
      serverId: 'echo',
    });

    try {
      await expect(
        gateway.callTool({
          arguments: { message: 'oversize' },
          server,
          toolName: 'echo',
          workspaceId: 'ws_demo',
        })
      ).rejects.toMatchObject({ code: 'mcp-result-too-large', upstreamEffect: 'contacted' });
      await expect(
        gateway.callTool({
          arguments: { message: 'crash' },
          server,
          toolName: 'echo',
          workspaceId: 'ws_demo',
        })
      ).rejects.toMatchObject({ code: 'mcp-call-failed', upstreamEffect: 'unknown' });
      await expect(
        gateway.callTool({
          arguments: { message: 'tool-error' },
          server,
          toolName: 'echo',
          workspaceId: 'ws_demo',
        })
      ).rejects.toMatchObject({ code: 'mcp-call-failed', upstreamEffect: 'contacted' });
    } finally {
      await gateway.close();
    }
  });

  it('classifies a tool-call timeout after successful initialization', async () => {
    const gateway = createDefaultWorkerMcpGateway();
    const server = stdioTestServer(5_000);

    try {
      await expect(gateway.listTools({ server, workspaceId: 'ws_demo' })).resolves.toMatchObject({
        tools: [{ name: 'echo' }],
      });
      await expect(
        gateway.callTool({
          arguments: { message: 'timeout' },
          server,
          toolName: 'echo',
          workspaceId: 'ws_demo',
        })
      ).rejects.toMatchObject({ code: 'mcp-timeout', upstreamEffect: 'unknown' });
      expect(gateway.getServerHealth({ server, workspaceId: 'ws_demo' })).toBe('degraded');
    } finally {
      await gateway.close();
    }
  });

  it('rejects a chunked HTTP result at the transport byte boundary', async () => {
    const upstream = await createMcpHttpStub({ chunkedCallResultBytes: 1024 * 1024 });
    const gateway = createDefaultWorkerMcpGateway();
    const server = httpTestServer(upstream.url, 2_000);

    try {
      await expect(
        gateway.callTool({
          arguments: { message: 'oversized-chunked' },
          server,
          toolName: 'echo',
          workspaceId: 'ws_demo',
        })
      ).rejects.toMatchObject({
        code: 'mcp-result-too-large',
        upstreamEffect: 'contacted',
      });
    } finally {
      await gateway.close();
      await upstream.close();
    }
  });

  it('does not attribute an oversized HTTP initialization response to a tool effect', async () => {
    const upstream = await createMcpHttpStub({ chunkedInitializeResultBytes: 1024 * 1024 });
    const gateway = createDefaultWorkerMcpGateway();
    const server = httpTestServer(upstream.url, 2_000);

    try {
      await expect(
        gateway.callTool({
          arguments: { message: 'never-dispatched' },
          server,
          toolName: 'echo',
          workspaceId: 'ws_demo',
        })
      ).rejects.toMatchObject({
        code: 'mcp-server-unavailable',
        upstreamEffect: 'not-contacted',
      });
      expect(upstream.observed.some((request) => request.endsWith('|tools/call'))).toBe(false);
    } finally {
      await gateway.close();
      await upstream.close();
    }
  });

  it('bounds initialization and drains gateway-private stdio stderr', async () => {
    const { coreDb, gateway } = createAuditedGateway();
    const floodServer = stdioTestServer(2_000);
    const floodCredential = 'flood-enabled-private-value';

    try {
      const live = await gateway.listTools({
        credentials: { environment: { OPENKIT_MCP_STDERR_FLOOD: floodCredential } },
        server: floodServer,
        workspaceId: 'ws_demo',
      });
      expect(live.tools).toMatchObject([{ name: 'echo' }]);
      expect(JSON.stringify(live)).not.toContain('private-stderr-canary');
      const startedAt = performance.now();
      await expect(
        gateway.listTools({
          credentials: { environment: { OPENKIT_MCP_INIT_HANG: 'hang-private-value' } },
          server: stdioTestServer(50),
          workspaceId: 'ws_demo',
        })
      ).rejects.toMatchObject({ code: 'mcp-timeout', credentialsMaterialized: true });
      expect(performance.now() - startedAt).toBeLessThan(6_000);
    } finally {
      await gateway.close();
      coreDb.sqlite.close();
    }
  });

  it('cancels an in-flight stdio call and fences its session', async () => {
    const gateway = createDefaultWorkerMcpGateway();
    const server = stdioTestServer(2_000);
    const cancellation = new AbortController();

    try {
      await gateway.listTools({ server, workspaceId: 'ws_demo' });
      const call = gateway.callTool({
        arguments: { message: 'timeout' },
        server,
        signal: cancellation.signal,
        toolName: 'echo',
        workspaceId: 'ws_demo',
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      cancellation.abort();
      await expect(call).rejects.toMatchObject({
        cancelled: true,
        code: 'mcp-call-failed',
        upstreamEffect: 'unknown',
      });
      expect(gateway.getServerHealth({ server, workspaceId: 'ws_demo' })).toBe('degraded');
    } finally {
      await gateway.close();
    }
  });

  it('does not dispatch a pre-cancelled call or misclassify a provider race', async () => {
    const gateway = createDefaultWorkerMcpGateway();
    const server = stdioTestServer(2_000);
    const preCancelled = new AbortController();
    preCancelled.abort();

    try {
      await expect(
        gateway.listTools({
          server,
          signal: preCancelled.signal,
          workspaceId: 'ws_demo',
        })
      ).rejects.toMatchObject({ cancelled: true, upstreamEffect: 'not-contacted' });
      await expect(
        gateway.callTool({
          arguments: { message: 'blocked' },
          server,
          signal: preCancelled.signal,
          toolName: 'echo',
          workspaceId: 'ws_demo',
        })
      ).rejects.toMatchObject({ cancelled: true, upstreamEffect: 'not-contacted' });
      expect(gateway.getServerHealth({ server, workspaceId: 'ws_demo' })).toBe('inactive');

      await gateway.listTools({ server, workspaceId: 'ws_demo' });
      const cancellation = new AbortController();
      const callTool = vi.spyOn(Client.prototype, 'callTool').mockImplementationOnce(async () => {
        setImmediate(() => cancellation.abort());
        throw new Error('provider failed first');
      });
      await expect(
        gateway.callTool({
          arguments: { message: 'race' },
          server,
          signal: cancellation.signal,
          toolName: 'echo',
          workspaceId: 'ws_demo',
        })
      ).rejects.toMatchObject({ cancelled: false, upstreamEffect: 'unknown' });
      await new Promise<void>((resolve) => setImmediate(resolve));
      callTool.mockRestore();
    } finally {
      await gateway.close();
    }
  });

  it('classifies caller cancellation while schema initialization is pending', async () => {
    const gateway = createDefaultWorkerMcpGateway();
    const cancellation = new AbortController();
    const connect = vi.spyOn(Client.prototype, 'connect').mockImplementationOnce(
      async (_transport, options) =>
        new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          });
        })
    );

    try {
      const listing = gateway.listTools({
        server: stdioTestServer(2_000),
        signal: cancellation.signal,
        workspaceId: 'ws_demo',
      });
      cancellation.abort();
      await expect(listing).rejects.toMatchObject({ cancelled: true });
    } finally {
      connect.mockRestore();
      await gateway.close();
    }
  });

  it('closes a credential-bearing HTTP session instead of health-pinging it', async () => {
    const upstream = await createMcpHttpStub();
    const { coreDb, gateway } = createAuditedGateway();
    const input = {
      credentials: { headers: { authorization: 'revoked-private-value' } },
      server: httpTestServer(upstream.url, 2_000),
      workspaceId: 'ws_demo',
    };

    try {
      await gateway.listTools(input);
      await vi.waitFor(() => expect(gateway.getServerHealth(input)).toBe('inactive'));
      expect(upstream.observed.filter((request) => request.endsWith('|DELETE|'))).toHaveLength(1);
      const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
      try {
        expect(
          workspaceDb.sqlite
            .prepare(
              `SELECT action FROM audit_events
               WHERE action IN ('mcp.server.lifecycle.degraded', 'mcp.server.lifecycle.failed')`
            )
            .all()
        ).toEqual([]);
      } finally {
        workspaceDb.sqlite.close();
      }
      expect(upstream.observed.some((request) => request.endsWith('|ping'))).toBe(false);
    } finally {
      await gateway.close();
      await upstream.close();
      coreDb.sqlite.close();
    }
  });

  it('retains a failed credential HTTP teardown for exact retry', async () => {
    const upstream = await createMcpHttpStub();
    const { coreDb, gateway } = createAuditedGateway();
    const input = {
      credentials: { headers: { authorization: 'retry-private-value' } },
      server: httpTestServer(upstream.url, 2_000),
      workspaceId: 'ws_demo',
    };
    const terminate = vi
      .spyOn(StreamableHTTPClientTransport.prototype, 'terminateSession')
      .mockRejectedValueOnce(new Error('injected teardown failure'));

    try {
      await expect(
        gateway.callTool({ ...input, arguments: { message: 'safe' }, toolName: 'echo' })
      ).rejects.toMatchObject({
        code: 'recovery_required',
        credentialsMaterialized: true,
        upstreamEffect: 'contacted',
      });
      const toolCalls = upstream.observed.filter((request) => request.endsWith('|tools/call'));
      await expect(
        gateway.callTool({ ...input, arguments: { message: 'retry' }, toolName: 'echo' })
      ).rejects.toMatchObject({ code: 'recovery_required' });
      expect(upstream.observed.filter((request) => request.endsWith('|tools/call'))).toEqual(
        toolCalls
      );
      terminate.mockRestore();
      await gateway.closeServer(input);
      expect(gateway.getServerHealth(input)).toBe('inactive');
      expect(upstream.observed.filter((request) => request.endsWith('|DELETE|'))).toHaveLength(1);
    } finally {
      terminate.mockRestore();
      await gateway.close();
      await upstream.close();
      coreDb.sqlite.close();
    }
  });

  it('bounds a hanging credential HTTP teardown and retains its retry fence', async () => {
    const upstreamOptions = { hangDelete: true };
    const upstream = await createMcpHttpStub(upstreamOptions);
    const { coreDb, gateway } = createAuditedGateway();
    const input = {
      credentials: { headers: { authorization: 'bounded-private-value' } },
      server: httpTestServer(upstream.url, 50),
      workspaceId: 'ws_demo',
    };
    const startedAt = Date.now();

    try {
      await expect(
        gateway.callTool({ ...input, arguments: { message: 'safe' }, toolName: 'echo' })
      ).rejects.toMatchObject({ code: 'recovery_required' });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      const initializations = upstream.observed.filter((request) =>
        request.endsWith('|initialize')
      );
      await expect(gateway.listTools(input)).rejects.toMatchObject({
        code: 'recovery_required',
      });
      expect(upstream.observed.filter((request) => request.endsWith('|initialize'))).toEqual(
        initializations
      );
      upstreamOptions.hangDelete = false;
      await gateway.closeServer(input);
      expect(gateway.getServerHealth(input)).toBe('inactive');
    } finally {
      upstreamOptions.hangDelete = false;
      await gateway.close();
      await upstream.close();
      coreDb.sqlite.close();
    }
  });

  it('retains initialization cleanup ownership until an exact retry succeeds', async () => {
    const upstream = await createMcpHttpStub();
    const { coreDb, gateway } = createAuditedGateway();
    const input = {
      credentials: { headers: { authorization: 'init-retry-private-value' } },
      server: httpTestServer(upstream.url, 2_000),
      workspaceId: 'ws_demo',
    };
    const connect = vi.spyOn(Client.prototype, 'connect').mockRejectedValueOnce(new Error('init'));
    const terminate = vi
      .spyOn(StreamableHTTPClientTransport.prototype, 'terminateSession')
      .mockRejectedValueOnce(new Error('cleanup'));

    try {
      await expect(gateway.listTools(input)).rejects.toMatchObject({
        code: 'recovery_required',
      });
      await expect(gateway.listTools(input)).rejects.toMatchObject({
        code: 'recovery_required',
      });
      expect(connect).toHaveBeenCalledTimes(1);
      terminate.mockRestore();
      await gateway.closeServer(input);
      expect(gateway.getServerHealth(input)).toBe('inactive');
    } finally {
      connect.mockRestore();
      terminate.mockRestore();
      await gateway.close();
      await upstream.close();
      coreDb.sqlite.close();
    }
  });

  it('rejects fresh sessions once gateway shutdown starts', async () => {
    const upstream = await createMcpHttpStub();
    const gateway = createDefaultWorkerMcpGateway();
    const input = { server: httpTestServer(upstream.url, 2_000), workspaceId: 'ws_demo' };
    let releaseTermination!: () => void;
    const heldTermination = new Promise<void>((resolve) => {
      releaseTermination = resolve;
    });
    const terminate = vi
      .spyOn(StreamableHTTPClientTransport.prototype, 'terminateSession')
      .mockImplementationOnce(() => heldTermination);

    try {
      await gateway.listTools(input);
      const closing = gateway.close();
      await vi.waitFor(() => expect(terminate).toHaveBeenCalledTimes(1));
      const initializations = upstream.observed.filter((request) =>
        request.endsWith('|initialize')
      );
      await expect(
        gateway.callTool({ ...input, arguments: { message: 'late' }, toolName: 'echo' })
      ).rejects.toMatchObject({ code: 'mcp-server-unavailable' });
      expect(upstream.observed.filter((request) => request.endsWith('|initialize'))).toEqual(
        initializations
      );
      releaseTermination();
      await closing;
    } finally {
      releaseTermination();
      terminate.mockRestore();
      await upstream.close();
    }
  });

  it('reaps a credential-bearing stdio descendant with its owned process group', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'worker-tool-process-group-'));
    const pidFile = join(dataRoot, 'descendant.pid');
    const credential = 'stdio-descendant-private-value';
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const gateway = createDefaultWorkerMcpGateway(coreDb);
    const server = stdioTestServer(10_000);
    const gatewayInput = {
      credentials: {
        environment: {
          OPENKIT_MCP_DESCENDANT_PID_FILE: pidFile,
          OPENKIT_MCP_DESCENDANT_SECRET: credential,
        },
      },
      server,
      workspaceId: 'ws_demo',
    };

    try {
      const activeCall = gateway.callTool({
        ...gatewayInput,
        arguments: { message: 'timeout' },
        toolName: 'echo',
      });
      const activeCallOutcome = activeCall.then(
        () => null,
        (error: unknown) => error
      );
      await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
      const descendantPid = Number(readFileSync(pidFile, 'utf8'));
      expect(readFileSync(`/proc/${descendantPid}/environ`, 'utf8')).toContain(credential);
      await gateway.closeWorkspace('ws_demo');
      expect(await activeCallOutcome).toMatchObject({ code: 'mcp-call-failed' });
      expect(() => process.kill(descendantPid, 0)).toThrow(
        expect.objectContaining({ code: 'ESRCH' })
      );
      rmSync(join(dataRoot, 'workspaces', 'ws_demo'), { recursive: true });
      vi.useFakeTimers({ toFake: ['clearTimeout', 'setTimeout'] });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(existsSync(join(dataRoot, 'workspaces', 'ws_demo'))).toBe(false);
    } finally {
      vi.useRealTimers();
      await gateway.close();
      coreDb.sqlite.close();
    }
  });

  it('reaps a credential-bearing descendant when stdio initialization exits', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'worker-tool-init-exit-'));
    const pidFile = join(dataRoot, 'descendant.pid');
    const { coreDb, gateway } = createAuditedGateway(dataRoot);

    try {
      await expect(
        gateway.listTools({
          credentials: {
            environment: {
              OPENKIT_MCP_DESCENDANT_PID_FILE: pidFile,
              OPENKIT_MCP_DESCENDANT_SECRET: 'init-exit-private-value',
              OPENKIT_MCP_INIT_EXIT: '1',
            },
          },
          server: stdioTestServer(2_000),
          workspaceId: 'ws_demo',
        })
      ).rejects.toMatchObject({ code: 'mcp-server-unavailable' });
      const descendantPid = Number(readFileSync(pidFile, 'utf8'));
      await expect(waitForProcessExit(descendantPid)).resolves.toBe(true);
    } finally {
      await gateway.close();
      coreDb.sqlite.close();
    }
  });

  it('does not spawn a credential-bearing stdio server when its starting audit fails', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'worker-tool-audit-failure-'));
    const pidFile = join(dataRoot, 'descendant.pid');
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
    applyScopedMigrations(workspaceDb);
    workspaceDb.sqlite.exec(`
      CREATE TRIGGER reject_mcp_start_audit
      BEFORE INSERT ON audit_events
      WHEN NEW.action = 'mcp.server.lifecycle.starting'
      BEGIN
        SELECT RAISE(ABORT, 'injected starting audit failure');
      END
    `);
    workspaceDb.sqlite.close();
    const gateway = createDefaultWorkerMcpGateway(coreDb);

    try {
      await expect(
        gateway.listTools({
          credentials: {
            environment: {
              OPENKIT_MCP_DESCENDANT_PID_FILE: pidFile,
              OPENKIT_MCP_DESCENDANT_SECRET: 'audit-private-value',
            },
          },
          server: stdioTestServer(2_000),
          workspaceId: 'ws_demo',
        })
      ).rejects.toMatchObject({ code: 'mcp-server-unavailable' });
      expect(existsSync(pidFile)).toBe(false);
    } finally {
      await gateway.close();
      coreDb.sqlite.close();
    }
  });

  it('reaps the stdio server and credential-bearing descendant after NanoCore process death', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'worker-tool-parent-death-'));
    const pidFile = join(dataRoot, 'descendant.pid');
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('../test-support/mcp-gateway-parent.ts', import.meta.url)),
        dataRoot,
        pidFile,
        fileURLToPath(new URL('../test-support/mcp-stdio-stub.mjs', import.meta.url)),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const line = await firstOutputLine(child.stdout!);
    const pids = JSON.parse(line) as { descendantPid: number; serverPid: number };

    try {
      expect(readFileSync(`/proc/${pids.descendantPid}/environ`, 'utf8')).toContain(
        'crash-private-value'
      );
      child.kill('SIGKILL');
      await once(child, 'close');
      await expect(waitForProcessExit(pids.serverPid)).resolves.toBe(true);
      await expect(waitForProcessExit(pids.descendantPid)).resolves.toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      for (const pid of [pids.serverPid, pids.descendantPid]) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
    }
  });

  it('does not reap a session while a tool call is active', async () => {
    vi.useFakeTimers({ toFake: ['clearTimeout', 'setTimeout'] });
    const ping = vi.spyOn(Client.prototype, 'ping').mockResolvedValue({});
    const upstream = await createMcpHttpStub({ delayMs: 60_001 });
    const gateway = createDefaultWorkerMcpGateway();
    const server = httpTestServer(upstream.url, 180_000);

    try {
      await gateway.listTools({ server, workspaceId: 'ws_demo' });
      const call = gateway.callTool({
        arguments: { message: 'delayed' },
        server,
        toolName: 'echo',
        workspaceId: 'ws_demo',
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(gateway.getServerHealth({ server, workspaceId: 'ws_demo' })).toBe('ready');
      await vi.advanceTimersByTimeAsync(1);
      await expect(call).resolves.toMatchObject({ content: [{ text: 'delayed' }] });
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(gateway.getServerHealth({ server, workspaceId: 'ws_demo' })).toBe('inactive');
    } finally {
      await gateway.close();
      await upstream.close();
      ping.mockRestore();
      vi.useRealTimers();
    }
  });

  it('does not let an idle cleanup terminate a concurrent credential call', async () => {
    const upstream = await createMcpHttpStub({ delayMs: 100 });
    const { coreDb, gateway } = createAuditedGateway();
    const server = httpTestServer(upstream.url, 2_000);
    const input = { server, workspaceId: 'ws_demo' };
    const call = gateway.callTool({
      ...input,
      arguments: { message: 'delayed' },
      credentials: { headers: { authorization: 'concurrent-private-value' } },
      toolName: 'echo',
    });

    try {
      await vi.waitFor(() =>
        expect(upstream.observed.some((request) => request.endsWith('|tools/call'))).toBe(true)
      );
      await gateway.closeServerIfIdle(input);
      expect(upstream.observed.some((request) => request.endsWith('|DELETE|'))).toBe(false);
      await expect(call).resolves.toMatchObject({ content: [{ text: 'delayed' }] });
      expect(upstream.observed.filter((request) => request.endsWith('|DELETE|'))).toHaveLength(1);
    } finally {
      await gateway.close();
      await upstream.close();
      coreDb.sqlite.close();
    }
  });

  it('does not resurrect a session after a concurrent credential rejection', async () => {
    const credential = 'Bearer concurrent-private-value';
    const upstream = await createMcpHttpStub({ credentialEcho: credential, delayMs: 100 });
    const { coreDb, gateway } = createAuditedGateway();
    const server = httpTestServer(upstream.url, 2_000);
    const credentials = { headers: { authorization: credential } };

    try {
      const delayed = gateway.callTool({
        arguments: { message: 'delayed' },
        credentials,
        server,
        toolName: 'echo',
        workspaceId: 'ws_demo',
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      await expect(
        gateway.callTool({
          arguments: { message: 'key-leak' },
          credentials,
          server,
          toolName: 'echo',
          workspaceId: 'ws_demo',
        })
      ).rejects.toMatchObject({ code: 'mcp-call-failed' });
      await expect(delayed).rejects.toMatchObject({
        code: 'mcp-call-failed',
        upstreamEffect: 'unknown',
      });
      expect(gateway.getServerHealth({ server, workspaceId: 'ws_demo' })).toBe('degraded');
    } finally {
      await gateway.close();
      await upstream.close();
      coreDb.sqlite.close();
    }
  });

  it('rejects V1 tool-list pagination without requesting another page', async () => {
    const upstream = await createMcpHttpStub({ nextCursor: 'next' });
    const gateway = createDefaultWorkerMcpGateway();
    const server = resolveWorkspaceMcpServer({
      catalog: {
        schemaVersion: 1,
        servers: [
          {
            allowedTools: ['echo'],
            approvalRequiredTools: [],
            credentialBindings: [],
            deniedTools: [],
            enabled: true,
            id: 'paged',
            pinnedSchemaSnapshotId: null,
            schemaPolicy: 'tracking',
            timeoutMs: 2_000,
            transport: { endpoint: upstream.url, kind: 'http' },
          },
        ],
      },
      serverId: 'paged',
    });

    try {
      await expect(gateway.listTools({ server, workspaceId: 'ws_demo' })).rejects.toMatchObject({
        code: 'mcp-server-unavailable',
      });
      expect(upstream.observed.filter((request) => request.endsWith('|tools/list'))).toHaveLength(
        1
      );
    } finally {
      await gateway.close();
      await upstream.close();
    }
  });

  it('retains proven credential materialization on an HTTP protocol error', async () => {
    const upstream = await createMcpHttpStub({ listError: true });
    const { coreDb, gateway } = createAuditedGateway();
    const server = httpTestServer(upstream.url, 2_000);

    try {
      await expect(
        gateway.listTools({
          credentials: { headers: { authorization: 'protocol-error-private-value' } },
          server,
          workspaceId: 'ws_demo',
        })
      ).rejects.toMatchObject({
        code: 'mcp-server-unavailable',
        credentialsMaterialized: true,
        upstreamEffect: 'contacted',
      });
    } finally {
      await gateway.close();
      await upstream.close();
      coreDb.sqlite.close();
    }
  });

  it('uses gateway-only HTTP credentials and rejects an exact credential echo', async () => {
    const credential = 'Bearer exact-"quoted\\slash';
    const upstream = await createMcpHttpStub({ credentialEcho: credential });
    const { coreDb, gateway } = createAuditedGateway();
    const server = resolveWorkspaceMcpServer({
      catalog: {
        schemaVersion: 1,
        servers: [
          {
            allowedTools: ['echo'],
            approvalRequiredTools: [],
            credentialBindings: [
              {
                sink: { kind: 'header', name: 'authorization' },
                slot: 'auth',
                vaultGrantId: 'grant_auth',
              },
              {
                sink: { kind: 'query', name: 'token' },
                slot: 'query',
                vaultGrantId: 'grant_query',
              },
            ],
            deniedTools: [],
            enabled: true,
            id: 'http-echo',
            pinnedSchemaSnapshotId: null,
            schemaPolicy: 'tracking',
            timeoutMs: 2_000,
            transport: { endpoint: upstream.url, kind: 'http' },
          },
        ],
      },
      serverId: 'http-echo',
    });
    const credentials = {
      headers: { authorization: credential },
      query: { token: 'query-canary' },
    };

    try {
      await expect(
        gateway.callTool({
          arguments: { message: 'safe' },
          credentials,
          server,
          toolName: 'echo',
          workspaceId: 'ws_demo',
        })
      ).resolves.toMatchObject({ content: [{ text: 'safe', type: 'text' }] });
      expect(gateway.getServerHealth({ server, workspaceId: 'ws_demo' })).toBe('inactive');
      expect(
        upstream.observed.some((request) => request.startsWith(`${credential}|query-canary|`))
      ).toBe(true);
      await expect(
        gateway.callTool({
          arguments: { message: 'key-leak' },
          credentials,
          server,
          toolName: 'echo',
          workspaceId: 'ws_demo',
        })
      ).rejects.toMatchObject({ code: 'mcp-call-failed' });
      expect(gateway.getServerHealth({ server, workspaceId: 'ws_demo' })).toBe('degraded');
    } finally {
      await gateway.close();
      await upstream.close();
      coreDb.sqlite.close();
    }
  });

  it('rejects credentials on a plaintext remote endpoint before transport', async () => {
    const { coreDb, gateway } = createAuditedGateway();
    const server = {
      ...resolveWorkspaceMcpServer({
        catalog: {
          schemaVersion: 1 as const,
          servers: [
            {
              allowedTools: ['echo'],
              credentialBindings: [],
              enabled: true,
              id: 'remote',
              schemaPolicy: 'tracking' as const,
              transport: { endpoint: 'http://mcp.example.test/mcp', kind: 'http' as const },
            },
          ],
        },
        serverId: 'remote',
      }),
      credentialBindings: [
        {
          sink: { kind: 'header' as const, name: 'authorization' },
          slot: 'auth',
          vaultGrantId: 'grant_auth',
        },
      ],
    };

    try {
      await expect(
        gateway.callTool({
          arguments: {},
          credentials: { headers: { authorization: 'canary' } },
          server,
          toolName: 'echo',
          workspaceId: 'ws_demo',
        })
      ).rejects.toMatchObject({ code: 'mcp-server-unavailable', upstreamEffect: 'not-contacted' });
    } finally {
      await gateway.close();
      coreDb.sqlite.close();
    }
  });

  it('rejects credentials in live tool metadata before returning it', async () => {
    const credential = 'Bearer schema-"quoted\\slash';
    const upstream = await createMcpHttpStub({ credentialListEcho: credential });
    const { coreDb, gateway } = createAuditedGateway();
    const server = resolveWorkspaceMcpServer({
      catalog: {
        schemaVersion: 1,
        servers: [
          {
            allowedTools: ['echo'],
            approvalRequiredTools: [],
            credentialBindings: [],
            deniedTools: [],
            enabled: true,
            id: 'http-echo',
            pinnedSchemaSnapshotId: null,
            schemaPolicy: 'tracking',
            timeoutMs: 2_000,
            transport: { endpoint: upstream.url, kind: 'http' },
          },
        ],
      },
      serverId: 'http-echo',
    });

    try {
      await expect(
        gateway.listTools({
          credentials: { headers: { authorization: credential } },
          server,
          workspaceId: 'ws_demo',
        })
      ).rejects.toMatchObject({ code: 'mcp-server-unavailable' });
      expect(gateway.getServerHealth({ server, workspaceId: 'ws_demo' })).toBe('degraded');
    } finally {
      await gateway.close();
      await upstream.close();
      coreDb.sqlite.close();
    }
  });
});

/** Creates one disposable durable Audit owner for credential-bearing gateway tests. */
function createAuditedGateway(dataRoot = mkdtempSync(join(tmpdir(), 'worker-tool-audit-'))) {
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  return { coreDb, gateway: createDefaultWorkerMcpGateway(coreDb) };
}

/** Reads the first newline-delimited child result under a hard test bound. */
async function firstOutputLine(stdout: NodeJS.ReadableStream): Promise<string> {
  stdout.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('MCP crash fixture timed out.')), 10_000);
    stdout.on('data', (chunk: string) => {
      output += chunk;
      const newline = output.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      resolve(output.slice(0, newline));
    });
  });
}

/** Waits until one exact disposable child pid is no longer addressable. */
async function waitForProcessExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}

/** Resolves one stdio fixture server with a caller-selected request bound. */
function stdioTestServer(timeoutMs: number) {
  return resolveWorkspaceMcpServer({
    catalog: {
      schemaVersion: 1,
      servers: [
        {
          allowedTools: ['echo'],
          approvalRequiredTools: [],
          credentialBindings: [],
          deniedTools: [],
          enabled: true,
          id: 'echo',
          pinnedSchemaSnapshotId: null,
          schemaPolicy: 'tracking',
          timeoutMs,
          transport: {
            args: [fileURLToPath(new URL('../test-support/mcp-stdio-stub.mjs', import.meta.url))],
            command: process.execPath,
            environment: {},
            kind: 'stdio',
          },
        },
      ],
    },
    serverId: 'echo',
  });
}

/** Resolves one HTTP fixture server with a caller-selected request bound. */
function httpTestServer(endpoint: string, timeoutMs: number) {
  return resolveWorkspaceMcpServer({
    catalog: {
      schemaVersion: 1,
      servers: [
        {
          allowedTools: ['echo'],
          approvalRequiredTools: [],
          credentialBindings: [],
          deniedTools: [],
          enabled: true,
          id: 'echo',
          pinnedSchemaSnapshotId: null,
          schemaPolicy: 'tracking',
          timeoutMs,
          transport: { endpoint, kind: 'http' },
        },
      ],
    },
    serverId: 'echo',
  });
}

import { spawn } from 'node:child_process';
import { once } from 'node:events';
