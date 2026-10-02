import { describe, expect, it } from 'vitest';

import {
  digestMcpConfig,
  getConfigPolicyCatalog,
  getConfigSchemaCatalog,
  parseWorkspaceMcpServerCatalog,
  resolveWorkspaceMcpServer,
  WorkspaceMcpServerCatalogSchema,
} from './index.js';
import {
  WorkspaceMcpCredentialBindingSchema,
  WorkspaceMcpHttpTransportSchema,
} from './mcp-catalog.js';
import { McpBindingRecordSchema } from './resource-catalog.js';

describe('MCP credential presentation admission', () => {
  const binding = {
    slot: 'token',
    vaultGrantId: 'grant_canary',
    sink: { kind: 'header', name: 'Authorization' },
  };
  const server = {
    allowedTools: ['echo'],
    credentialBindings: [binding],
    enabled: true,
    id: 'echo',
    schemaPolicy: 'tracking',
    transport: { endpoint: 'https://mcp.example.test/mcp', kind: 'http' },
  };

  it('keeps omitted presentation absent and retains the raw effective digest', () => {
    const catalog = parseWorkspaceMcpServerCatalog({ schemaVersion: 1, servers: [server] });
    expect(catalog.servers[0]!.credentialBindings).toEqual([binding]);
    expect(resolveWorkspaceMcpServer({ catalog, serverId: 'echo' }).catalogDigest).toBe(
      'sha256:ece03620450bfab5be716543f17a1e8f7846e24d9cd612a245f8bcd6a2cd5df5'
    );
    expect(JSON.stringify(WorkspaceMcpCredentialBindingSchema.parse(binding))).toBe(
      JSON.stringify(binding)
    );
  });

  it.each([
    'raw',
    'bearer',
  ] as const)('preserves recognized %s presentation in canonical and effective bindings', (presentation) => {
    const credential = { ...binding, presentation };
    const canonical = McpBindingRecordSchema.parse({
      allowedTools: ['echo'],
      credentialBindings: [credential],
      enabled: true,
      entryId: 'echo',
      packageDataKey: 'mcp_echo',
      revision: 1,
      schemaPolicy: 'tracking',
    });
    const effective = parseWorkspaceMcpServerCatalog({
      schemaVersion: 1,
      servers: [{ ...server, credentialBindings: [credential] }],
    });
    expect(canonical.credentialBindings).toEqual([credential]);
    expect(effective.servers[0]!.credentialBindings).toEqual([credential]);
  });

  it('rejects an unknown presentation in canonical and effective readers', () => {
    const credential = { ...binding, presentation: 'basic' };
    expect(WorkspaceMcpCredentialBindingSchema.safeParse(credential).success).toBe(false);
    expect(
      WorkspaceMcpServerCatalogSchema.safeParse({
        schemaVersion: 1,
        servers: [{ ...server, credentialBindings: [credential] }],
      }).success
    ).toBe(false);
  });

  it.each([
    { kind: 'header', name: 'X-API-Key' },
    { kind: 'query', name: 'Authorization' },
    { kind: 'env', name: 'Authorization' },
  ])('rejects bearer presentation on $kind sink $name', (sink) => {
    expect(() =>
      WorkspaceMcpCredentialBindingSchema.parse({ ...binding, presentation: 'bearer', sink })
    ).toThrow(/Bearer presentation requires an Authorization header sink/);
  });

  it('admits mixed-case Authorization bearer only on HTTP', () => {
    const credential = {
      ...binding,
      presentation: 'bearer',
      sink: { kind: 'header', name: 'aUtHoRiZaTiOn' },
    };
    expect(() =>
      parseWorkspaceMcpServerCatalog({
        schemaVersion: 1,
        servers: [{ ...server, credentialBindings: [credential] }],
      })
    ).not.toThrow();
    expect(() =>
      parseWorkspaceMcpServerCatalog({
        schemaVersion: 1,
        servers: [
          {
            ...server,
            credentialBindings: [credential],
            transport: { command: 'node', kind: 'stdio' },
          },
        ],
      })
    ).toThrow(/does not match/);
  });
});

describe('workspace MCP server catalog', () => {
  it('preserves authored endpoint query strings while rejecting URL credentials and fragments', () => {
    const endpoint = 'https://mcp.example.test/mcp?read-only=true';
    expect(WorkspaceMcpHttpTransportSchema.parse({ kind: 'http', endpoint }).endpoint).toBe(
      endpoint
    );
    for (const invalid of [
      'https://user:password@mcp.example.test/mcp',
      'https://mcp.example.test/mcp#fragment',
    ]) {
      expect(
        WorkspaceMcpHttpTransportSchema.safeParse({ kind: 'http', endpoint: invalid }).success
      ).toBe(false);
    }
  });

  it('bounds timeouts to the Node timer range', () => {
    const input = (timeoutMs: number) => ({
      schemaVersion: 1,
      servers: [
        {
          allowedTools: ['echo'],
          enabled: true,
          id: 'echo',
          schemaPolicy: 'tracking',
          timeoutMs,
          transport: { args: [], command: 'node', kind: 'stdio' },
        },
      ],
    });

    expect(() => WorkspaceMcpServerCatalogSchema.parse(input(2_147_483_647))).not.toThrow();
    expect(() => WorkspaceMcpServerCatalogSchema.parse(input(2_147_483_648))).toThrow();
  });

  it('resolves strict credential-free stdio entries with a stable digest', () => {
    const input = {
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
          timeoutMs: 60_000,
          transport: {
            args: ['fixtures/echo.mjs'],
            command: 'node',
            environment: {},
            kind: 'stdio',
          },
        },
      ],
    } as const;
    const catalog = parseWorkspaceMcpServerCatalog(input);
    const resolved = resolveWorkspaceMcpServer({ catalog, serverId: 'echo' });
    const reordered = parseWorkspaceMcpServerCatalog({
      servers: input.servers,
      schemaVersion: input.schemaVersion,
    });

    expect(resolved).toMatchObject({
      allowedTools: ['echo'],
      catalogDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      id: 'echo',
      schemaPolicy: 'tracking',
      transport: { kind: 'stdio' },
    });
    expect(resolveWorkspaceMcpServer({ catalog: reordered, serverId: 'echo' }).catalogDigest).toBe(
      resolved.catalogDigest
    );
  });

  it('accepts only transport-matched grant sinks and strict catalog fields', () => {
    expect(() =>
      WorkspaceMcpServerCatalogSchema.parse({
        schemaVersion: 1,
        servers: [
          {
            allowedTools: ['search'],
            approvalRequiredTools: ['search'],
            credentialBindings: [
              {
                sink: { kind: 'header', name: 'Authorization' },
                slot: 'access-token',
                vaultGrantId: 'grant_search',
              },
            ],
            deniedTools: [],
            enabled: true,
            id: 'search',
            schemaPolicy: 'pinned',
            timeoutMs: 30_000,
            transport: { endpoint: 'https://mcp.example.test/mcp', kind: 'http' },
          },
        ],
      })
    ).not.toThrow();

    for (const name of ['Accept', 'content-type']) {
      expect(() =>
        WorkspaceMcpServerCatalogSchema.parse({
          schemaVersion: 1,
          servers: [
            {
              allowedTools: ['search'],
              credentialBindings: [
                {
                  sink: { kind: 'header', name },
                  slot: 'token',
                  vaultGrantId: 'grant_search',
                },
              ],
              enabled: true,
              id: 'search',
              schemaPolicy: 'tracking',
              transport: { endpoint: 'https://mcp.example.test/mcp', kind: 'http' },
            },
          ],
        })
      ).toThrow(/SDK-owned HTTP headers/);
    }

    for (const endpoint of [
      'http://localhost:3000/mcp',
      'http://127.0.0.1:3000/mcp',
      'http://[::1]:3000/mcp',
      'https://mcp.example.test/mcp',
    ]) {
      expect(() =>
        WorkspaceMcpServerCatalogSchema.parse({
          schemaVersion: 1,
          servers: [
            {
              allowedTools: ['search'],
              credentialBindings: [
                {
                  sink: { kind: 'header', name: 'Authorization' },
                  slot: 'token',
                  vaultGrantId: 'grant_search',
                },
              ],
              enabled: true,
              id: 'search',
              schemaPolicy: 'tracking',
              transport: { endpoint, kind: 'http' },
            },
          ],
        })
      ).not.toThrow();
    }

    expect(() =>
      WorkspaceMcpServerCatalogSchema.parse({
        schemaVersion: 1,
        servers: [
          {
            allowedTools: ['search'],
            credentialBindings: [
              {
                sink: { kind: 'header', name: 'Authorization' },
                slot: 'token',
                vaultGrantId: 'grant_search',
              },
            ],
            enabled: true,
            id: 'search',
            schemaPolicy: 'tracking',
            transport: { endpoint: 'http://mcp.example.test/mcp', kind: 'http' },
          },
        ],
      })
    ).toThrow(/must use HTTPS/);

    for (const sinks of [
      [
        { kind: 'header', name: 'Authorization' },
        { kind: 'header', name: 'authorization' },
      ],
      [
        { kind: 'query', name: 'token' },
        { kind: 'query', name: 'token' },
      ],
    ]) {
      expect(() =>
        WorkspaceMcpServerCatalogSchema.parse({
          schemaVersion: 1,
          servers: [
            {
              allowedTools: ['search'],
              credentialBindings: sinks.map((sink, index) => ({
                sink,
                slot: `token-${index}`,
                vaultGrantId: `grant_${index}`,
              })),
              enabled: true,
              id: 'search',
              schemaPolicy: 'tracking',
              transport: { endpoint: 'https://mcp.example.test/mcp', kind: 'http' },
            },
          ],
        })
      ).toThrow();
    }

    expect(() =>
      WorkspaceMcpServerCatalogSchema.parse({
        schemaVersion: 1,
        servers: [
          {
            allowedTools: ['echo'],
            credentialBindings: [
              {
                sink: { kind: 'env', name: 'ACCESS_TOKEN' },
                slot: 'access-token',
                vaultGrantId: 'grant_echo',
              },
            ],
            enabled: true,
            id: 'echo',
            schemaPolicy: 'tracking',
            transport: {
              command: 'node',
              environment: { ACCESS_TOKEN: { credentialSlot: 'access-token' } },
              kind: 'stdio',
            },
          },
        ],
      })
    ).not.toThrow();

    for (const server of [
      {
        allowedTools: [' echo '],
        credentialBindings: [],
        enabled: true,
        id: 'echo',
        schemaPolicy: 'tracking',
        transport: { command: 'node', kind: 'stdio' },
      },
      {
        allowedTools: ['echo'],
        approvalRequiredTools: [],
        credentialBindings: [
          {
            sink: { kind: 'header', name: 'Authorization' },
            slot: 'token',
            vaultGrantId: 'grant_echo',
          },
        ],
        deniedTools: [],
        enabled: true,
        id: 'echo',
        schemaPolicy: 'tracking',
        transport: { command: 'node', kind: 'stdio' },
      },
      {
        allowedTools: ['echo'],
        credentialBindings: [],
        enabled: true,
        id: 'echo',
        schemaPolicy: 'tracking',
        transport: {
          command: 'node',
          environment: { ACCESS_TOKEN: 'credential-like-opaque-value' },
          kind: 'stdio',
        },
      },
      {
        allowedTools: ['echo'],
        credentialBindings: [
          {
            sink: { kind: 'env', name: 'ACCESS_TOKEN' },
            slot: 'access-token',
            vaultGrantId: 'grant_echo',
          },
        ],
        enabled: true,
        id: 'echo',
        schemaPolicy: 'tracking',
        transport: {
          command: 'node',
          environment: { ACCESS_TOKEN: { credentialSlot: 'another-slot' } },
          kind: 'stdio',
        },
      },
      {
        allowedTools: ['echo'],
        approvalRequiredTools: [],
        credentialBindings: [],
        deniedTools: [],
        enabled: true,
        id: 'echo',
        rawToken: 'not-allowed',
        schemaPolicy: 'tracking',
        transport: { command: 'node', kind: 'stdio' },
      },
    ]) {
      expect(() =>
        WorkspaceMcpServerCatalogSchema.parse({ schemaVersion: 1, servers: [server] })
      ).toThrow();
    }
  });

  it('exports the Workspace MCP schema and session-scoped policy', () => {
    expect(getConfigSchemaCatalog()).toContainEqual(
      expect.objectContaining({ kind: 'mcp-server', title: 'OpenKit workspace MCP server catalog' })
    );
    expect(getConfigPolicyCatalog()).toContainEqual(
      expect.objectContaining({
        kind: 'mcp-server',
        owner: 'workspace',
        path: '$.servers',
        reloadClass: 'session-scoped',
        secretPolicy: 'secret-ref-only',
      })
    );
  });

  it('keeps MCP configuration identity stable across key order and changes with package roots', () => {
    const declaration = { args: ['a'], command: 'node', kind: 'stdio' };
    const left = digestMcpConfig({ command: 'node', kind: 'stdio', args: ['a'] }, null);
    const right = digestMcpConfig(declaration, null);
    expect(left).toBe(right);
    expect(left).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(digestMcpConfig(declaration, 'sha256:' + 'a'.repeat(64))).not.toBe(left);
  });

  it('includes packageRootDigest in the effective catalogDigest', () => {
    const server = {
      allowedTools: ['echo'],
      approvalRequiredTools: [],
      credentialBindings: [],
      deniedTools: [],
      enabled: true,
      id: 'echo',
      pinnedSchemaSnapshotId: null,
      schemaPolicy: 'tracking' as const,
      timeoutMs: 60_000,
      transport: {
        args: [],
        command: 'node',
        cwd: null,
        environment: {},
        environmentValues: {},
        kind: 'stdio' as const,
      },
    };
    const digestA = `sha256:${'a'.repeat(64)}`;
    const digestB = `sha256:${'b'.repeat(64)}`;
    const catalogA = parseWorkspaceMcpServerCatalog({
      schemaVersion: 1,
      servers: [{ ...server, packageRootDigest: digestA }],
    });
    const catalogB = parseWorkspaceMcpServerCatalog({
      schemaVersion: 1,
      servers: [{ ...server, packageRootDigest: digestB }],
    });
    const catalogNone = parseWorkspaceMcpServerCatalog({ schemaVersion: 1, servers: [server] });
    const digestNone = resolveWorkspaceMcpServer({
      catalog: catalogNone,
      serverId: 'echo',
    });
    const digestFromA = resolveWorkspaceMcpServer({ catalog: catalogA, serverId: 'echo' });
    const digestFromB = resolveWorkspaceMcpServer({ catalog: catalogB, serverId: 'echo' });
    expect(digestNone.packageRootDigest).toBeNull();
    expect(digestFromA.catalogDigest).not.toBe(digestFromB.catalogDigest);
    expect(digestFromA.catalogDigest).not.toBe(digestNone.catalogDigest);
  });
});
