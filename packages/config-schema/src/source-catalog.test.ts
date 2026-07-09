import { describe, expect, it } from 'vitest';

import {
  getConfigPolicyCatalog,
  getConfigSchemaCatalog,
  parseWorkspaceDataSourceCatalog,
  resolveWorkspaceDataSourceReference,
  WorkspaceDataSourceCatalogSchema,
  WorkspaceDataSourceSchema,
} from './index.js';

describe('workspace data source catalog schema', () => {
  it('accepts endpoint-bearing sources with non-secret locators', () => {
    const parsed = parseWorkspaceDataSourceCatalog({
      schemaVersion: 1,
      sources: [
        {
          id: 'main-repo',
          kind: 'git',
          displayName: 'Main repository',
          locator: { url: 'https://github.com/acme/app.git', defaultRef: 'main' },
          access: 'read-write',
          sensitivity: 'internal',
          vaultGrantRef: 'vg_github_ci',
          allowedSlotKinds: ['worktree'],
          syncHints: { strategy: 'checkout' },
          status: 'active',
        },
      ],
    });

    expect(parsed.sources[0]).toMatchObject({
      id: 'main-repo',
      kind: 'git',
      access: 'read-write',
      status: 'active',
      requiredFeatures: [],
      extensions: {},
    });
  });

  it('rejects duplicate ids, unsupported required features, and secret-like locators', () => {
    expect(() =>
      WorkspaceDataSourceCatalogSchema.parse({
        schemaVersion: 1,
        sources: [
          {
            id: 'repo',
            kind: 'git',
            displayName: 'Repo',
            locator: { url: 'https://github.com/acme/app.git' },
            access: 'read-only',
            sensitivity: 'internal',
            allowedSlotKinds: ['worktree'],
            status: 'active',
          },
          {
            id: 'repo',
            kind: 'r2',
            displayName: 'Corpus',
            locator: { bucket: 'research' },
            access: 'read-only',
            sensitivity: 'internal',
            allowedSlotKinds: ['data'],
            status: 'active',
          },
        ],
      })
    ).toThrow();
    expect(() =>
      WorkspaceDataSourceSchema.parse({
        id: 'corpus',
        kind: 'r2',
        displayName: 'Corpus',
        locator: { bucket: 'research', token: 'raw-secret' },
        access: 'read-only',
        sensitivity: 'internal',
        allowedSlotKinds: ['data'],
        status: 'active',
      })
    ).toThrow();
    expect(() =>
      WorkspaceDataSourceSchema.parse({
        id: 'credential-url',
        kind: 'git',
        displayName: 'Credential URL',
        locator: { url: 'https://user:pass@example.com/acme/app.git' },
        access: 'read-only',
        sensitivity: 'internal',
        allowedSlotKinds: ['worktree'],
        status: 'active',
      })
    ).toThrow();
    expect(() =>
      WorkspaceDataSourceSchema.parse({
        id: 'future',
        kind: 'r2',
        displayName: 'Future source',
        locator: { endpoint: 'https://example.com' },
        access: 'read-only',
        sensitivity: 'internal',
        allowedSlotKinds: ['data'],
        status: 'active',
        requiredFeatures: ['workspace.source.future'],
      })
    ).toThrow();
  });

  it('preserves unknown optional fields and fails closed for unsupported registered features', () => {
    const raw = {
      schemaVersion: 1,
      sources: [
        {
          id: 'mounted-corpus',
          kind: 'r2',
          displayName: 'Mounted corpus',
          locator: { bucket: 'research', prefix: 'papers/' },
          access: 'read-only',
          sensitivity: 'internal',
          allowedSlotKinds: ['data'],
          status: 'active',
          requiredFeatures: ['workspace.mount.fuse'],
          reviewNote: 'kept for operator review',
        },
      ],
      reviewBatch: 'batch-1',
    };

    expect(() => parseWorkspaceDataSourceCatalog(raw)).toThrow(/Unsupported required feature/);
    const parsed = parseWorkspaceDataSourceCatalog(raw, {
      supportedFeatures: ['workspace.mount.fuse'],
    });

    expect(parsed).toMatchObject({
      reviewBatch: 'batch-1',
      sources: [
        {
          reviewNote: 'kept for operator review',
        },
      ],
    });
  });

  it('exports schema and policy catalog entries', () => {
    expect(getConfigSchemaCatalog()).toContainEqual(
      expect.objectContaining({
        kind: 'data-source',
        title: 'OpenKit workspace data source catalog',
      })
    );
    expect(getConfigPolicyCatalog()).toContainEqual(
      expect.objectContaining({
        kind: 'data-source',
        path: '$.sources',
        owner: 'workspace',
        secretPolicy: 'secret-ref-only',
      })
    );
  });

  it('resolves source refs without widening access', () => {
    const catalog = parseWorkspaceDataSourceCatalog({
      schemaVersion: 1,
      sources: [
        {
          id: 'main-repo',
          kind: 'git',
          displayName: 'Main repository',
          locator: { url: 'https://github.com/acme/app.git', defaultRef: 'main' },
          access: 'read-write',
          sensitivity: 'internal',
          vaultGrantRef: 'grant_github_read',
          allowedSlotKinds: ['worktree'],
          status: 'active',
        },
      ],
    });
    const resolved = resolveWorkspaceDataSourceReference({
      access: 'read-only',
      catalog,
      slotKind: 'worktree',
      sourceRef: 'main-repo',
    });

    expect(resolved).toMatchObject({
      access: 'read-only',
      catalogEntryDigest: expect.stringMatching(/^sha256:/),
      locator: { url: 'https://github.com/acme/app.git', defaultRef: 'main' },
      sourceId: 'main-repo',
      sourceKind: 'git',
      vaultGrantRef: 'grant_github_read',
    });
    expect(
      resolveWorkspaceDataSourceReference({
        access: 'read-only',
        catalog,
        slotKind: 'worktree',
        sourceRef: 'main-repo',
      }).catalogEntryDigest
    ).toBe(resolved.catalogEntryDigest);
  });

  it('rejects unusable source refs', () => {
    const catalog = parseWorkspaceDataSourceCatalog({
      schemaVersion: 1,
      sources: [
        {
          id: 'readonly-repo',
          kind: 'git',
          displayName: 'Read-only repository',
          locator: { url: 'https://github.com/acme/app.git' },
          access: 'read-only',
          sensitivity: 'internal',
          allowedSlotKinds: ['worktree'],
          status: 'active',
        },
        {
          id: 'disabled-corpus',
          kind: 'r2',
          displayName: 'Disabled corpus',
          locator: { bucket: 'research' },
          access: 'read-only',
          sensitivity: 'internal',
          allowedSlotKinds: ['data'],
          status: 'disabled',
        },
      ],
    });

    expect(() =>
      resolveWorkspaceDataSourceReference({
        access: 'read-only',
        catalog,
        slotKind: 'worktree',
        sourceRef: 'missing',
      })
    ).toThrow('Workspace data source not found: missing');
    expect(() =>
      resolveWorkspaceDataSourceReference({
        access: 'read-write',
        catalog,
        slotKind: 'worktree',
        sourceRef: 'readonly-repo',
      })
    ).toThrow('Workspace data source access denied: readonly-repo');
    expect(() =>
      resolveWorkspaceDataSourceReference({
        access: 'read-only',
        catalog,
        slotKind: 'data',
        sourceRef: 'readonly-repo',
      })
    ).toThrow('Workspace data source slot denied: readonly-repo');
    expect(() =>
      resolveWorkspaceDataSourceReference({
        access: 'read-only',
        catalog,
        slotKind: 'data',
        sourceRef: 'disabled-corpus',
      })
    ).toThrow('Workspace data source disabled: disabled-corpus');
  });
});
