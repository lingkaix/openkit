import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  getConfigPolicyCatalog,
  getConfigSchemaCatalog,
  parseWorkspaceDataSourceCatalog,
  requireCredentialFreeHttpsGitLocator,
  resolveWorkspaceDataSourceReference,
  WorkspaceDataSourceCatalogSchema,
  WorkspaceDataSourceSchema,
} from './index.js';

describe('workspace data source catalog schema', () => {
  it('requires one exact credential-free HTTPS Git locator', () => {
    const commit = '0123456789abcdef0123456789abcdef01234567';
    expect(() =>
      requireCredentialFreeHttpsGitLocator({
        commit,
        url: 'https://git.example.test/openkit/repository.git',
      })
    ).not.toThrow();

    for (const locator of [
      { commit, url: 'https://git.example.test/openkit/repository.git?ref=private-review' },
      { commit, url: 'https://git.example.test/openkit/repository.git#private-review' },
      { commit, url: 'https://user@git.example.test/openkit/repository.git' },
      { commit, extra: 'not-accepted', url: 'https://git.example.test/openkit/repository.git' },
      { url: 'https://git.example.test/openkit/repository.git' },
      { commit },
      { commit: 'main', url: 'https://git.example.test/openkit/repository.git' },
    ]) {
      expect(() => requireCredentialFreeHttpsGitLocator(locator)).toThrow();
    }
  });

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
          vaultGrantRef: 'grant_00000000-0000-7e99-a28a-bfc3f4b6a7ed',
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
          vaultGrantRef: 'grant_00000000-0000-7d98-b1e4-8d2f442e5137',
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
      vaultGrantRef: 'grant_00000000-0000-7d98-b1e4-8d2f442e5137',
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

  it.each(['en', 'de', 'sv'])(
    'keeps catalog-entry identity in code-unit order under %s collation',
    (locale) => {
      const labels = { z: 'lower-z', ä: 'umlaut', Z: 'upper', Å: 'ring', a: 'lower-a' };
      const catalog = parseWorkspaceDataSourceCatalog({
        schemaVersion: 1,
        sources: [
          {
            id: 'corpus',
            kind: 'r2',
            displayName: 'Corpus',
            locator: { bucket: 'research', labels, prefix: 'papers/' },
            access: 'read-only',
            sensitivity: 'internal',
            allowedSlotKinds: ['data'],
            status: 'active',
          },
        ],
      });
      // Source Catalog: a stable catalog-entry digest pins the granted input after catalog edits.
      // The admitted Protocol codec orders UTF-16 units; these expected bytes use no subject helper.
      const expectedBytes =
        '{"access":"read-only","allowedSlotKinds":["data"],"displayName":"Corpus",' +
        '"extensions":{},"id":"corpus","kind":"r2","locator":{"bucket":"research",' +
        '"labels":{"Z":"upper","a":"lower-a","z":"lower-z","Å":"ring","ä":"umlaut"},' +
        '"prefix":"papers/"},"requiredFeatures":[],"sensitivity":"internal",' +
        '"status":"active","syncHints":{}}';
      const expectedDigest = `sha256:${createHash('sha256').update(expectedBytes, 'utf8').digest('hex')}`;
      expect(Intl.Collator.supportedLocalesOf([locale])).toEqual([locale]);
      const collator = new Intl.Collator(locale);
      expect(Math.sign(collator.compare('ä', 'z'))).toBe(locale === 'sv' ? 1 : -1);
      const comparison = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(function (
        this: string,
        other: string
      ) {
        return collator.compare(String(this), other);
      });
      try {
        const request = { access: 'read-only', slotKind: 'data', sourceRef: 'corpus' } as const;
        const resolved = resolveWorkspaceDataSourceReference({ ...request, catalog });
        expect(resolved.catalogEntryDigest).toBe(expectedDigest);
        expect(resolved.locator).toEqual({ bucket: 'research', labels, prefix: 'papers/' });
        const source = catalog.sources[0]!;
        const reordered = parseWorkspaceDataSourceCatalog({
          schemaVersion: 1,
          sources: [
            {
              ...source,
              locator: {
                prefix: 'papers/',
                labels: Object.fromEntries(Object.entries(labels).reverse()),
                bucket: 'research',
              },
            },
          ],
        });
        expect(
          resolveWorkspaceDataSourceReference({ ...request, catalog: reordered }).catalogEntryDigest
        ).toBe(expectedDigest);
        const edited = parseWorkspaceDataSourceCatalog({
          schemaVersion: 1,
          sources: [{ ...source, locator: { ...source.locator, prefix: 'other/' } }],
        });
        expect(
          resolveWorkspaceDataSourceReference({ ...request, catalog: edited }).catalogEntryDigest
        ).not.toBe(expectedDigest);
        expect(resolved.catalogEntryDigest).toBe(expectedDigest);
        expect(resolved.locator.prefix).toBe('papers/');
      } finally {
        comparison.mockRestore();
      }
    }
  );

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
