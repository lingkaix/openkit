import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerControlGatewayError } from './worker-control-gateway.js';
import { createDefaultWorkerMcpGateway } from './worker-mcp-gateway.js';

describe('worker MCP gateway', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reuses initialized stdio MCP servers across default gateway calls', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openkit-mcp-gateway-reuse-'));
    const serverPath = join(dir, 'server.mjs');

    writeFileSync(
      serverPath,
      `
import { createInterface } from 'node:readline/promises';
const lines = createInterface({ input: process.stdin });
let initialized = 0;
let calls = 0;
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    initialized += 1;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { serverInfo: { name: 'reuse-stub', version: '1.0.0' } } }) + '\\n');
  }
  if (message.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'repos.get', inputSchema: { additionalProperties: false, properties: { owner: { type: 'string' } }, required: ['owner'], type: 'object' } }] } }) + '\\n');
  }
  if (message.method === 'tools/call') {
    calls += 1;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { structuredContent: { calls, initialized, pid: process.pid } } }) + '\\n');
    if (calls >= 2) {
      process.exit(0);
    }
    setTimeout(() => process.exit(0), 1000);
  }
}
`
    );

    const gateway = createDefaultWorkerMcpGateway();
    const server = {
      allowedPrompts: [],
      allowedTools: ['repos.get'],
      command: [process.execPath, serverPath],
      id: 'github',
      networkPolicyHints: [],
      providerInstanceIds: [],
      secretRefIds: [],
      toolSchemas: [
        {
          inputSchema: {
            additionalProperties: false,
            properties: { owner: { type: 'string' } },
            required: ['owner'],
            type: 'object',
          },
          name: 'repos.get',
        },
      ],
      transport: 'stdio' as const,
      vaultGrantIds: [],
    };

    try {
      const first = await gateway.callTool({
        arguments: { owner: 'openkit' },
        server,
        toolName: 'repos.get',
      });
      const second = await gateway.callTool({
        arguments: { owner: 'openkit' },
        server,
        toolName: 'repos.get',
      });

      expect(second).toMatchObject({
        calls: 2,
        initialized: 1,
        pid: first.pid,
      });
    } finally {
      await gateway.close?.();
    }
  });

  it('closes stdio sessions created with explicit credentials', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openkit-mcp-gateway-close-credentials-'));
    const serverPath = join(dir, 'server.mjs');

    writeFileSync(
      serverPath,
      `
import { createInterface } from 'node:readline/promises';
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\\n');
  }
  if (message.method === 'tools/call') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { structuredContent: { pid: process.pid } } }) + '\\n');
  }
}
`
    );

    const gateway = createDefaultWorkerMcpGateway();
    const server = {
      allowedPrompts: [],
      allowedTools: ['repos.get'],
      command: [process.execPath, serverPath],
      id: 'explicit-credentials-test',
      networkPolicyHints: [],
      providerInstanceIds: [],
      secretRefIds: [],
      toolSchemas: [],
      transport: 'stdio' as const,
      vaultGrantIds: [],
    };

    try {
      const first = await gateway.callTool({
        arguments: {},
        credentials: { environment: { TEST_TOKEN: 'secret' } },
        server,
        toolName: 'repos.get',
      });

      await gateway.closeServer?.(server);

      const second = await gateway.callTool({
        arguments: {},
        credentials: { environment: { TEST_TOKEN: 'secret' } },
        server,
        toolName: 'repos.get',
      });

      expect(second.pid).not.toBe(first.pid);
    } finally {
      await gateway.close?.();
    }
  });

  it('reports credentialed stdio health after unavailable calls and recovery', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openkit-mcp-gateway-health-'));
    const serverPath = join(dir, 'server.mjs');
    const statePath = join(dir, 'state.txt');

    writeFileSync(
      serverPath,
      `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
const statePath = process.argv[2];
const previous = existsSync(statePath) ? Number(readFileSync(statePath, 'utf8')) : 0;
writeFileSync(statePath, String(previous + 1));
const shouldCrash = previous === 0;
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\\n');
  }
  if (message.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'repos.get', inputSchema: { additionalProperties: false, required: ['owner'], type: 'object' } }] } }) + '\\n');
  }
  if (message.method === 'tools/call') {
    if (shouldCrash) {
      process.exit(9);
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { structuredContent: { ok: true } } }) + '\\n');
  }
}
`
    );

    const gateway = createDefaultWorkerMcpGateway();
    const server = {
      allowedPrompts: [],
      allowedTools: ['repos.get'],
      command: [process.execPath, serverPath, statePath],
      id: 'github',
      networkPolicyHints: [],
      providerInstanceIds: [],
      secretRefIds: [],
      toolSchemas: [
        {
          inputSchema: {
            additionalProperties: false,
            required: ['owner'],
            type: 'object',
          },
          name: 'repos.get',
        },
      ],
      transport: 'stdio' as const,
      vaultGrantIds: [],
    };

    try {
      expect(gateway.getServerHealth?.(server)).toBe('ready');
      await expect(
        gateway.callTool({
          arguments: { owner: 'openkit' },
          credentials: { environment: { TEST_TOKEN: 'secret' } },
          server,
          toolName: 'repos.get',
        })
      ).rejects.toMatchObject({ code: 'mcp-server-unavailable' });
      expect(gateway.getServerHealth?.(server)).toBe('degraded');
      await expect(
        gateway.callTool({
          arguments: { owner: 'openkit' },
          credentials: { environment: { TEST_TOKEN: 'secret' } },
          server,
          toolName: 'repos.get',
        })
      ).resolves.toEqual({ ok: true });
      expect(gateway.getServerHealth?.(server)).toBe('ready');
    } finally {
      await gateway.close?.();
    }
  });

  it('times out cached stdio calls and replaces the stalled session', async () => {
    const realSetTimeout = setTimeout;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const dir = mkdtempSync(join(tmpdir(), 'openkit-mcp-gateway-timeout-'));
    const serverPath = join(dir, 'server.mjs');
    const statePath = join(dir, 'state.txt');

    writeFileSync(
      serverPath,
      `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
const statePath = process.argv[2];
const previous = existsSync(statePath) ? Number(readFileSync(statePath, 'utf8')) : 0;
writeFileSync(statePath, String(previous + 1));
const shouldHang = previous === 0;
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (shouldHang) {
    continue;
  }
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\\n');
  }
  if (message.method === 'tools/call') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { structuredContent: { recovered: true } } }) + '\\n');
  }
}
`
    );

    const gateway = createDefaultWorkerMcpGateway();
    const server = {
      allowedPrompts: [],
      allowedTools: ['repos.get'],
      command: [process.execPath, serverPath, statePath],
      id: 'timeout-test',
      networkPolicyHints: [],
      providerInstanceIds: [],
      secretRefIds: [],
      toolSchemas: [],
      transport: 'stdio' as const,
      vaultGrantIds: [],
    };

    try {
      const outcome = gateway.callTool({ arguments: {}, server, toolName: 'repos.get' }).then(
        (value) => ({ status: 'resolved' as const, value }),
        (error) => ({ error, status: 'rejected' as const })
      );

      for (let attempt = 0; attempt < 100 && !existsSync(statePath); attempt += 1) {
        await new Promise<void>((resolve) => realSetTimeout(resolve, 10));
      }
      expect(existsSync(statePath)).toBe(true);
      await vi.advanceTimersByTimeAsync(60_000);

      const pending = Symbol('pending');
      const settled = await Promise.race([outcome, Promise.resolve(pending)]);

      expect(settled).not.toBe(pending);
      expect(settled).toMatchObject({
        error: {
          code: 'mcp-timeout',
          message: 'MCP tool call timed out.',
          status: 504,
        },
        status: 'rejected',
      });
      expect(gateway.getServerHealth?.(server)).toBe('degraded');
      await expect(
        gateway.callTool({ arguments: {}, server, toolName: 'repos.get' })
      ).resolves.toEqual({ recovered: true });
      expect(gateway.getServerHealth?.(server)).toBe('ready');
    } finally {
      await gateway.close?.();
    }
  });

  it('reports live stdio tool schemas when pinned schemas are checked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openkit-mcp-gateway-live-schema-'));
    const serverPath = join(dir, 'server.mjs');
    const snapshots: unknown[] = [];

    writeFileSync(
      serverPath,
      `
import { createInterface } from 'node:readline/promises';
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { serverInfo: { name: 'stub', version: '1.0.0' } } }) + '\\n');
  }
  if (message.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'repos.get', inputSchema: { additionalProperties: false, required: ['owner'], type: 'object' } }] } }) + '\\n');
  }
  if (message.method === 'tools/call') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { structuredContent: { ok: true } } }) + '\\n');
  }
}
`
    );

    const gateway = createDefaultWorkerMcpGateway();
    const server = {
      allowedPrompts: [],
      allowedTools: ['repos.get'],
      command: [process.execPath, serverPath],
      id: 'live-schema-test',
      networkPolicyHints: [],
      providerInstanceIds: [],
      secretRefIds: [],
      toolSchemas: [
        {
          inputSchema: {
            additionalProperties: false,
            required: ['owner'],
            type: 'object',
          },
          name: 'repos.get',
        },
      ],
      transport: 'stdio' as const,
      vaultGrantIds: [],
    };

    try {
      await expect(
        gateway.callTool({
          arguments: { owner: 'openkit' },
          liveSchemaSnapshotSink: (snapshot) => snapshots.push(snapshot),
          server,
          toolName: 'repos.get',
        })
      ).resolves.toEqual({ ok: true });
      expect(snapshots).toEqual([
        {
          serverInfo: { name: 'stub', version: '1.0.0' },
          tools: [
            {
              inputSchema: {
                additionalProperties: false,
                required: ['owner'],
                type: 'object',
              },
              name: 'repos.get',
            },
          ],
        },
      ]);
    } finally {
      await gateway.close?.();
    }
  });

  it('calls HTTP MCP tools through the default gateway', async () => {
    const seenMethods: string[] = [];
    const seenAuthorizations: Array<string | null> = [];
    vi.stubGlobal('fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      const message = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
        params?: { arguments?: Record<string, unknown>; name?: string };
      };
      seenAuthorizations.push(new Headers(init?.headers).get('authorization'));
      seenMethods.push(message.method);

      if (message.method === 'initialize') {
        return Response.json({ id: message.id, jsonrpc: '2.0', result: {} });
      }

      return Response.json({
        id: message.id,
        jsonrpc: '2.0',
        result: {
          structuredContent: {
            echoed: message.params?.arguments,
            tool: message.params?.name,
          },
        },
      });
    });

    await expect(
      createDefaultWorkerMcpGateway().callTool({
        arguments: { owner: 'openkit', repo: 'openkit' },
        server: {
          allowedPrompts: [],
          allowedTools: ['repos.get'],
          id: 'http-test',
          networkPolicyHints: [],
          providerInstanceIds: [],
          secretRefIds: [],
          toolSchemas: [],
          transport: 'http',
          url: 'https://mcp.example.test',
          vaultGrantIds: [],
        },
        toolName: 'repos.get',
      })
    ).resolves.toEqual({
      echoed: { owner: 'openkit', repo: 'openkit' },
      tool: 'repos.get',
    });
    expect(seenMethods).toEqual(['initialize', 'tools/call']);
    expect(seenAuthorizations).toEqual([null, null]);
  });

  it('injects GitHub credentials only into GitHub stdio MCP servers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openkit-mcp-gateway-env-'));
    const serverPath = join(dir, 'server.mjs');

    writeFileSync(
      serverPath,
      `
import { createInterface } from 'node:readline/promises';
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\\n');
  }
  if (message.method === 'tools/call') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { structuredContent: { token: process.env.GITHUB_TOKEN, npmToken: process.env.NPM_TOKEN ?? null } } }) + '\\n');
  }
}
`
    );

    const gateway = createDefaultWorkerMcpGateway({
      env: { GITHUB_TOKEN: 'github-secret-token', NPM_TOKEN: 'npm-secret-token' },
    });

    try {
      await expect(
        gateway.callTool({
          arguments: {},
          server: {
            allowedPrompts: [],
            allowedTools: ['repos.get'],
            command: [process.execPath, serverPath],
            id: 'github',
            networkPolicyHints: [],
            providerInstanceIds: ['provider_github_read'],
            secretRefIds: ['vault_github_read'],
            toolSchemas: [],
            transport: 'stdio',
            vaultGrantIds: ['grant_github_read'],
          },
          toolName: 'repos.get',
        })
      ).resolves.toEqual({
        npmToken: null,
        token: '[REDACTED]',
      });
    } finally {
      await gateway.close?.();
    }
  });

  it('injects GitHub authorization only into GitHub HTTP MCP servers', async () => {
    let authorizationHeader: string | null = null;

    vi.stubGlobal('fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      const message = JSON.parse(String(init?.body)) as { id: number; method: string };
      const headers = new Headers(init?.headers);
      authorizationHeader = headers.get('authorization');

      if (message.method === 'initialize') {
        return Response.json({ id: message.id, jsonrpc: '2.0', result: {} });
      }

      return Response.json({
        id: message.id,
        jsonrpc: '2.0',
        result: {
          structuredContent: {
            authorization: headers.get('authorization'),
          },
        },
      });
    });

    await expect(
      createDefaultWorkerMcpGateway({
        env: { GITHUB_TOKEN: 'github-secret-token', NPM_TOKEN: 'npm-secret-token' },
      }).callTool({
        arguments: {},
        server: {
          allowedPrompts: [],
          allowedTools: ['repos.get'],
          id: 'github-http',
          networkPolicyHints: [],
          providerInstanceIds: ['provider_github_read'],
          secretRefIds: ['vault_github_read'],
          toolSchemas: [],
          transport: 'http',
          url: 'https://mcp.example.test',
          vaultGrantIds: ['grant_github_read'],
        },
        toolName: 'repos.get',
      })
    ).resolves.toEqual({
      authorization: '[REDACTED]',
    });
    expect(authorizationHeader).toBe('Bearer github-secret-token');
  });

  it('normalizes MCP JSON-RPC errors without leaking server messages', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openkit-mcp-gateway-error-'));
    const serverPath = join(dir, 'server.mjs');

    writeFileSync(
      serverPath,
      `
import { createInterface } from 'node:readline/promises';
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\\n');
  }
  if (message.method === 'tools/call') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'secret stack trace' } }) + '\\n');
  }
}
`
    );

    const gateway = createDefaultWorkerMcpGateway();
    const server = {
      allowedPrompts: [],
      allowedTools: ['repos.get'],
      command: [process.execPath, serverPath],
      id: 'error-test',
      networkPolicyHints: [],
      providerInstanceIds: [],
      secretRefIds: [],
      toolSchemas: [],
      transport: 'stdio' as const,
      vaultGrantIds: [],
    };

    try {
      await expect(
        gateway.callTool({ arguments: {}, server, toolName: 'repos.get' })
      ).rejects.toMatchObject<Partial<WorkerControlGatewayError>>({
        code: 'mcp-call-failed',
        message: 'MCP tool call failed.',
        status: 502,
      });
    } finally {
      await gateway.close?.();
    }
  });

  it('normalizes missing stdio MCP server executables as unavailable', async () => {
    const gateway = createDefaultWorkerMcpGateway();
    const server = {
      allowedPrompts: [],
      allowedTools: ['repos.get'],
      command: ['/openkit/missing/mcp-server'],
      id: 'missing-executable-test',
      networkPolicyHints: [],
      providerInstanceIds: [],
      secretRefIds: [],
      toolSchemas: [],
      transport: 'stdio' as const,
      vaultGrantIds: [],
    };

    try {
      await expect(
        gateway.callTool({ arguments: {}, server, toolName: 'repos.get' })
      ).rejects.toMatchObject<Partial<WorkerControlGatewayError>>({
        code: 'mcp-server-unavailable',
        message: 'MCP server is unavailable.',
        status: 503,
      });
    } finally {
      await gateway.close?.();
    }
  });

  it('normalizes stdio MCP server exits before initialize as unavailable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openkit-mcp-gateway-exit-'));
    const serverPath = join(dir, 'server.mjs');

    writeFileSync(serverPath, `process.exit(7);\n`);

    const gateway = createDefaultWorkerMcpGateway();
    const server = {
      allowedPrompts: [],
      allowedTools: ['repos.get'],
      command: [process.execPath, serverPath],
      id: 'early-exit-test',
      networkPolicyHints: [],
      providerInstanceIds: [],
      secretRefIds: [],
      toolSchemas: [],
      transport: 'stdio' as const,
      vaultGrantIds: [],
    };

    try {
      await expect(
        gateway.callTool({ arguments: {}, server, toolName: 'repos.get' })
      ).rejects.toMatchObject<Partial<WorkerControlGatewayError>>({
        code: 'mcp-server-unavailable',
        message: 'MCP server is unavailable.',
        status: 503,
      });
    } finally {
      await gateway.close?.();
    }
  });

  it('rejects oversized MCP tool results without returning the payload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openkit-mcp-gateway-large-'));
    const serverPath = join(dir, 'server.mjs');

    writeFileSync(
      serverPath,
      `
import { createInterface } from 'node:readline/promises';
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\\n');
  }
  if (message.method === 'tools/call') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { structuredContent: { text: 'x'.repeat(1_048_577) } } }) + '\\n');
  }
}
`
    );

    const gateway = createDefaultWorkerMcpGateway();
    const server = {
      allowedPrompts: [],
      allowedTools: ['repos.get'],
      command: [process.execPath, serverPath],
      id: 'oversized-result-test',
      networkPolicyHints: [],
      providerInstanceIds: [],
      secretRefIds: [],
      toolSchemas: [],
      transport: 'stdio' as const,
      vaultGrantIds: [],
    };

    try {
      await expect(
        gateway.callTool({ arguments: {}, server, toolName: 'repos.get' })
      ).rejects.toMatchObject<Partial<WorkerControlGatewayError>>({
        code: 'mcp-result-too-large',
        message: 'MCP tool result exceeds the gateway payload limit.',
        status: 413,
      });
    } finally {
      await gateway.close?.();
    }
  });

  it('redacts credential-shaped fields from MCP tool results', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openkit-mcp-gateway-redact-'));
    const serverPath = join(dir, 'server.mjs');

    writeFileSync(
      serverPath,
      `
import { createInterface } from 'node:readline/promises';
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\\n');
  }
  if (message.method === 'tools/call') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { structuredContent: { nested: { apiKey: 'secret-api-key' }, token: 'secret-token', value: 'safe' } } }) + '\\n');
  }
}
`
    );

    const gateway = createDefaultWorkerMcpGateway();
    const server = {
      allowedPrompts: [],
      allowedTools: ['repos.get'],
      command: [process.execPath, serverPath],
      id: 'redaction-test',
      networkPolicyHints: [],
      providerInstanceIds: [],
      secretRefIds: [],
      toolSchemas: [],
      transport: 'stdio' as const,
      vaultGrantIds: [],
    };

    try {
      await expect(
        gateway.callTool({ arguments: {}, server, toolName: 'repos.get' })
      ).resolves.toEqual({
        nested: { apiKey: '[REDACTED]' },
        token: '[REDACTED]',
        value: 'safe',
      });
    } finally {
      await gateway.close?.();
    }
  });

  it('rejects pinned MCP schema drift before tool execution', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openkit-mcp-gateway-drift-'));
    const serverPath = join(dir, 'server.mjs');

    writeFileSync(
      serverPath,
      `
import { createInterface } from 'node:readline/promises';
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\\n');
  }
  if (message.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'repos.get', inputSchema: { required: ['owner'], type: 'object' } }] } }) + '\\n');
  }
  if (message.method === 'tools/call') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { structuredContent: { shouldNotRun: true } } }) + '\\n');
  }
}
`
    );

    const gateway = createDefaultWorkerMcpGateway();
    const server = {
      allowedPrompts: [],
      allowedTools: ['repos.get'],
      command: [process.execPath, serverPath],
      id: 'schema-drift-test',
      networkPolicyHints: [],
      providerInstanceIds: [],
      secretRefIds: [],
      toolSchemas: [
        {
          inputSchema: {
            required: ['owner', 'repo'],
            type: 'object',
          },
          name: 'repos.get',
        },
      ],
      transport: 'stdio' as const,
      vaultGrantIds: [],
    };

    try {
      await expect(
        gateway.callTool({
          arguments: { owner: 'openkit', repo: 'openkit' },
          server,
          toolName: 'repos.get',
        })
      ).rejects.toMatchObject<Partial<WorkerControlGatewayError>>({
        code: 'mcp-schema-drift',
        message: 'MCP tool schema drift detected.',
        status: 409,
      });
    } finally {
      await gateway.close?.();
    }
  });
});
