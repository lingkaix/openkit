import { describe, expect, it } from 'vitest';
import {
  digestMcpConfig,
  EMPTY_RESOURCE_CATALOG,
  LightAppDefinitionVersionRecordSchema,
  parsePortableAgentResourceCatalog,
  parsePortableSkillPayload,
  parseResourceCatalogDocument,
  ResourceCatalogDocumentSchema,
  ResourceCatalogDocumentViewSchema,
} from './index.js';

const digest = `sha256:${'1'.repeat(64)}`;
const version = {
  createdAt: '2026-10-17T00:00:00.000Z',
  definitionJson: '{"collections":[]}',
  digest,
  entryId: 'admissions',
  parentDigest: null,
  producer: { id: 'user-1', kind: 'user' },
};

describe('Light App resource catalog records', () => {
  it('loads existing documents with an empty additive definition group', () => {
    const { lightApps: _lightApps, ...prior } = EMPTY_RESOURCE_CATALOG;
    expect(parseResourceCatalogDocument(prior).lightApps).toEqual({
      entries: [],
      pins: [],
      versions: [],
    });
  });

  it('keeps stable catalog IDs and bounded inline definition strings exact', () => {
    expect(LightAppDefinitionVersionRecordSchema.safeParse(version).success).toBe(true);
    expect(
      LightAppDefinitionVersionRecordSchema.safeParse({ ...version, entryId: 'Bad_ID' }).success
    ).toBe(false);
    expect(
      LightAppDefinitionVersionRecordSchema.safeParse({
        ...version,
        definitionJson: 'x'.repeat(262_145),
      }).success
    ).toBe(false);
    expect(
      LightAppDefinitionVersionRecordSchema.safeParse({ ...version, script: 'run()' }).success
    ).toBe(false);
  });

  it('preserves same-owner history annotations and drops them from public projections', () => {
    const document = {
      ...EMPTY_RESOURCE_CATALOG,
      lightApps: {
        entries: [
          {
            availability: 'available',
            currentDigest: digest,
            displayName: 'Admissions',
            id: 'admissions',
            annotation: 'entry',
          },
        ],
        pins: [{ digest, entryId: 'admissions', annotation: 'pin' }],
        versions: [
          {
            ...version,
            annotation: 'history',
            producer: { ...version.producer, annotation: 'actor' },
          },
        ],
        annotation: 'group',
      },
    };
    expect(ResourceCatalogDocumentSchema.safeParse(document).success).toBe(false);
    const retained = parseResourceCatalogDocument(document);
    expect(retained.lightApps).toEqual(document.lightApps);
    expect(ResourceCatalogDocumentViewSchema.parse(retained).lightApps.versions[0]).toEqual(
      version
    );
  });

  it('enforces UTF-8 byte length on Light App definitions and verifies retained MCP digests and secrets', () => {
    // 131,073 two-byte characters: string.length <= 262,144, but UTF-8 byteLength === 262,146 > 262,144.
    const multibyteOverflow = 'é'.repeat(131_073);
    expect(multibyteOverflow.length).toBeLessThanOrEqual(262_144);
    expect(
      LightAppDefinitionVersionRecordSchema.safeParse({
        ...version,
        definitionJson: multibyteOverflow,
      }).success
    ).toBe(false);

    const declaration = {
      args: [],
      command: 'node',
      cwd: null,
      environment: {},
      environmentSlots: {},
      kind: 'stdio' as const,
    };
    const validMcpVersion = {
      createdAt: '2026-10-17T00:00:00.000Z',
      declaration,
      digest: digestMcpConfig(declaration, null),
      digestFormat: 'openkit-mcp-config-v1' as const,
      entryId: 'echo',
      packageRootDigest: null,
      pluginVersionDigest: null,
      provenance: { pluginMemberKey: null, sourceCommit: null, uploadedSourceId: null },
      publisherLabel: null,
    };
    expect(
      parseResourceCatalogDocument({
        ...EMPTY_RESOURCE_CATALOG,
        mcp: { ...EMPTY_RESOURCE_CATALOG.mcp, versions: [validMcpVersion] },
      }).mcp.versions
    ).toHaveLength(1);

    expect(() =>
      parseResourceCatalogDocument({
        ...EMPTY_RESOURCE_CATALOG,
        mcp: {
          ...EMPTY_RESOURCE_CATALOG.mcp,
          versions: [{ ...validMcpVersion, digest: `sha256:${'2'.repeat(64)}` }],
        },
      })
    ).toThrow('Retained MCP configuration digest mismatch.');

    expect(() =>
      parseResourceCatalogDocument({
        ...EMPTY_RESOURCE_CATALOG,
        skills: {
          ...EMPTY_RESOURCE_CATALOG.skills,
          entries: [
            {
              availability: 'available',
              currentDigest: null,
              description: 'leaked sk-canary token',
              displayName: 'Alpha',
              id: 'alpha',
            },
          ],
        },
      })
    ).toThrow('Resource catalogs must not contain raw-secret-shaped strings.');
  });

  it('validates portable resource catalog projections and portable skill payloads', () => {
    const portable = {
      schemaVersion: 1 as const,
      lightApps: {
        entries: [
          {
            availability: 'available' as const,
            displayName: 'Admissions',
            id: 'admissions',
            sourceCurrentDigest: digest,
          },
        ],
        pins: [{ digest, entryId: 'admissions' }],
        versions: [version],
      },
      mcp: {
        entries: [{ availability: 'available' as const, displayName: 'Echo', id: 'echo' }],
        versions: [
          {
            contentUnavailable: true as const,
            createdAt: '2026-10-17T00:00:00.000Z',
            digest,
            digestFormat: 'openkit-mcp-config-v1' as const,
            entryId: 'echo',
            pluginVersionDigest: null,
            provenance: { pluginMemberKey: null, sourceCommit: null, uploadedSourceId: null },
            publisherLabel: null,
          },
        ],
      },
      plugins: { entries: [], versions: [] },
      skills: {
        candidates: [],
        entries: [
          {
            availability: 'available' as const,
            description: null,
            displayName: 'Alpha',
            id: 'alpha',
            sourceCurrentDigest: digest,
          },
        ],
        pins: [],
        versions: [],
      },
    };
    expect(parsePortableAgentResourceCatalog(portable)).toEqual(portable);
    expect(() =>
      parsePortableAgentResourceCatalog({
        ...portable,
        mcp: {
          ...portable.mcp,
          entries: [{ ...portable.mcp.entries[0]!, currentVersionDigest: digest }],
        },
      })
    ).toThrow();

    const payload = {
      digest,
      entryId: 'alpha',
      tree: [{ kind: 'file' as const, path: 'SKILL.md', contentBase64: 'IyBAlphaCg==' }],
    };
    expect(parsePortableSkillPayload(payload)).toEqual(payload);
    expect(() => parsePortableSkillPayload({ ...payload, tree: [] })).toThrow();
  });
});
