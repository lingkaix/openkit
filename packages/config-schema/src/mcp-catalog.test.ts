import { describe, expect, it } from 'vitest';

import {
  getConfigPolicyCatalog,
  getConfigSchemaCatalog,
  parseWorkspaceMcpServerCatalog,
  resolveWorkspaceMcpServer,
  WorkspaceMcpServerCatalogSchema,
} from './index.js';

describe('workspace MCP server catalog', () => {
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
});
