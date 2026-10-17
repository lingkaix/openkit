import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LightAppSchemaInput } from '@openkit/app-api-schemas';
import { stableJson } from '@openkit/config-schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  verifyWorkspaceExportTree,
  writeWorkspaceExportTree,
} from '../storage/workspace-export.js';
import { readWorkspaceImportSnapshot } from '../storage/workspace-import.js';
import {
  projectWorkspaceCatalogExport,
  readPortableAgentResourceCatalog,
  reconstructImportedWorkspaceCatalog,
  writeImportedWorkspaceCatalog,
} from './catalog-portability.js';
import {
  exportWorkspaceLightAppDefinition,
  importWorkspaceLightAppDefinition,
  importWorkspaceLightAppDefinitionHistory,
  listWorkspaceLightAppDefinitions,
  readWorkspaceLightAppDefinition,
  resolveWorkspaceLightAppDefinition,
  selectWorkspaceLightAppDefinitionDefault,
  setWorkspaceLightAppDefinitionPin,
} from './light-app-catalog.js';
import {
  CatalogConflictError,
  CatalogInputError,
  CatalogIntegrityError,
  CatalogNotFoundError,
  catalogDocumentPath,
  importWorkspaceSkill,
  loadWorkspaceResourceCatalog,
} from './resource-catalog.js';

const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const producer = { id: 'user-1', kind: 'user' as const };
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Creates an isolated catalog owner input with no business database. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-light-app-catalog-'));
  roots.push(dataRoot);
  return { dataRoot, workspaceId };
}

/** Supplies the strict existing Light App definition shape. */
function definition(title = 'Admissions'): LightAppSchemaInput {
  return {
    format: 'openkit.light-app',
    schemaVersion: 1,
    title,
    purpose: 'Track synthetic admissions.',
    collections: [
      {
        name: 'applications',
        type: 'base',
        indexes: [],
        description: 'Synthetic applications.',
        fields: [{ name: 'name', type: 'text', required: false, description: 'Applicant name.' }],
      },
    ],
  };
}

/** Imports a definition with explicit revision and historical actor facts. */
function add(input: ReturnType<typeof fixture>, expectedRevision = 0, title = 'Admissions') {
  return importWorkspaceLightAppDefinition({
    ...input,
    expectedRevision,
    entryId: 'admissions',
    displayName: 'Admissions',
    definition: definition(title),
    producer,
    createdAt: '2026-10-17T00:00:00.000Z',
    selectDefault: true,
  });
}

describe('Light App definition catalog', () => {
  it('allocates stable definition identities once and reuses them for authored-name reimport', () => {
    const input = fixture();
    const first = add(input);
    const admitted = JSON.parse(first.version.definitionJson) as LightAppSchemaInput;
    expect(admitted.collections[0].id).toMatch(/^col_/);
    expect(admitted.collections[0].fields[0].id).toMatch(/^fld_/);
    const repeated = add(input, first.catalog.revision);
    expect(repeated.version.digest).toBe(first.version.digest);
    expect(repeated.version).toEqual(first.version);
    expect(repeated.catalog.lightApps.versions).toHaveLength(1);
  });

  it('keeps supplied collection and field identities through an explicit template rename', () => {
    const input = fixture();
    const first = add(input);
    const admitted = JSON.parse(first.version.definitionJson) as LightAppSchemaInput;
    const collection = admitted.collections[0];
    const renamed = importWorkspaceLightAppDefinition({
      ...input,
      expectedRevision: first.catalog.revision,
      entryId: 'admissions',
      displayName: 'Admissions',
      producer,
      createdAt: '2026-10-18T00:00:00.000Z',
      selectDefault: true,
      parentDigest: first.version.digest,
      definition: {
        ...admitted,
        collections: [
          {
            ...collection,
            name: 'submissions',
            fields: [{ ...collection.fields[0], name: 'applicant_name' }],
          },
        ],
      },
    });
    const next = JSON.parse(renamed.version.definitionJson) as LightAppSchemaInput;
    expect(next.collections[0].id).toBeDefined();
    expect(next.collections[0].fields[0].id).toBeDefined();
    expect(next.collections[0].id).toBe(collection.id);
    expect(next.collections[0].fields[0].id).toBe(collection.fields[0].id);
    expect(next.collections[0].name).toBe('submissions');
    expect(next.collections[0].fields[0].name).toBe('applicant_name');
    expect(renamed.version.parentDigest).toBe(first.version.digest);
  });

  it('refuses dangling index and relation selectors before changing catalog bytes', () => {
    const input = fixture();
    const first = add(input);
    const path = catalogDocumentPath(input.dataRoot, input.workspaceId);
    const before = readFileSync(path, 'utf8');
    const authored = definition();
    const collection = authored.collections[0];
    expect(() =>
      importWorkspaceLightAppDefinition({
        ...input,
        expectedRevision: first.catalog.revision,
        entryId: 'admissions',
        displayName: 'Admissions',
        producer,
        createdAt: '2026-10-18T00:00:00.000Z',
        definition: {
          ...authored,
          collections: [{ ...collection, indexes: [{ fields: ['missing'], unique: true }] }],
        },
      })
    ).toThrow(CatalogInputError);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(() =>
      importWorkspaceLightAppDefinition({
        ...input,
        expectedRevision: first.catalog.revision,
        entryId: 'admissions',
        displayName: 'Admissions',
        producer,
        createdAt: '2026-10-18T00:00:00.000Z',
        definition: {
          ...authored,
          collections: [
            {
              ...collection,
              fields: [
                ...collection.fields,
                {
                  name: 'school',
                  type: 'relation',
                  required: false,
                  description: 'Related school.',
                  options: { collection: 'missing' },
                },
              ],
            },
          ],
        },
      })
    ).toThrow(CatalogInputError);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('refuses a correctly hashed external history with a dangling selector without changing the catalog', () => {
    const input = fixture();
    const first = add(input);
    const path = catalogDocumentPath(input.dataRoot, input.workspaceId);
    const before = readFileSync(path, 'utf8');
    const exported = exportWorkspaceLightAppDefinition({ ...input, entryId: 'admissions' });
    const admitted = JSON.parse(first.version.definitionJson) as LightAppSchemaInput;
    const definitionJson = stableJson({
      ...admitted,
      collections: [
        { ...admitted.collections[0], indexes: [{ fields: ['missing'], unique: true }] },
      ],
    });
    const digest = `sha256:${createHash('sha256').update(definitionJson).digest('hex')}`;
    expect(() =>
      importWorkspaceLightAppDefinitionHistory({
        ...input,
        expectedRevision: first.catalog.revision,
        export: {
          ...exported,
          entry: { ...exported.entry, currentDigest: digest },
          versions: [{ ...first.version, definitionJson, digest }],
        },
      })
    ).toThrow(CatalogInputError);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('retains immutable history, explicit selection and pin rollback across restart', async () => {
    const input = fixture();
    const first = add(input);
    const second = add(input, first.catalog.revision, 'Admissions v2');
    expect(second.version.parentDigest).toBe(first.version.digest);
    const pinned = setWorkspaceLightAppDefinitionPin({
      ...input,
      expectedRevision: second.catalog.revision,
      entryId: 'admissions',
      digest: first.version.digest,
      expectedPinDigest: null,
    });
    expect(resolveWorkspaceLightAppDefinition({ ...input, entryId: 'admissions' })).toMatchObject({
      selectionSource: 'pin',
      version: first.version,
      definition: definition(),
    });
    expect(
      resolveWorkspaceLightAppDefinition({
        ...input,
        entryId: 'admissions',
        digest: second.version.digest,
      }).selectionSource
    ).toBe('explicit');
    const rolledBack = selectWorkspaceLightAppDefinitionDefault({
      ...input,
      expectedRevision: pinned.revision,
      entryId: 'admissions',
      digest: first.version.digest,
      expectedCurrentDigest: second.version.digest,
    });
    setWorkspaceLightAppDefinitionPin({
      ...input,
      expectedRevision: rolledBack.revision,
      entryId: 'admissions',
      digest: null,
      expectedPinDigest: first.version.digest,
    });
    vi.resetModules();
    const restarted = await import('./light-app-catalog.js');
    expect(
      restarted.resolveWorkspaceLightAppDefinition({ ...input, entryId: 'admissions' })
    ).toMatchObject({ selectionSource: 'default', version: first.version });
    expect(listWorkspaceLightAppDefinitions(input).entries).toHaveLength(1);
    expect(readWorkspaceLightAppDefinition({ ...input, entryId: 'admissions' }).versions).toEqual([
      first.version,
      second.version,
    ]);
  });

  it('exports exact definition history and imports it without carrying live selection', () => {
    const input = fixture();
    const first = add(input);
    const second = add(input, first.catalog.revision, 'Admissions v2');
    setWorkspaceLightAppDefinitionPin({
      ...input,
      expectedRevision: second.catalog.revision,
      entryId: 'admissions',
      digest: first.version.digest,
    });
    const exported = exportWorkspaceLightAppDefinition({ ...input, entryId: 'admissions' });
    expect(exported.pin?.digest).toBe(first.version.digest);
    const target = fixture();
    importWorkspaceLightAppDefinitionHistory({
      ...target,
      expectedRevision: 0,
      export: exported,
      entryId: 'admissions-copy',
    });
    const read = readWorkspaceLightAppDefinition({ ...target, entryId: 'admissions-copy' });
    expect(read.entry.currentDigest).toBeNull();
    expect(read.pin).toBeNull();
    expect(read.versions.map(({ entryId: _entryId, ...version }) => version)).toEqual(
      exported.versions.map(({ entryId: _entryId, ...version }) => version)
    );
    expect(() =>
      resolveWorkspaceLightAppDefinition({ ...target, entryId: 'admissions-copy' })
    ).toThrow(CatalogNotFoundError);
  });

  it('keeps the first immutable facts for identical content and preserves owned annotations', () => {
    const input = fixture();
    const first = add(input);
    const path = catalogDocumentPath(input.dataRoot, input.workspaceId);
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.lightApps.versions[0].annotation = 'retained history';
    raw.lightApps.versions[0].producer.annotation = 'retained actor';
    raw.lightApps.entries[0].annotation = 'retained entry';
    writeFileSync(path, JSON.stringify(raw));
    const again = importWorkspaceLightAppDefinition({
      ...input,
      expectedRevision: first.catalog.revision,
      entryId: 'admissions',
      displayName: 'Admissions',
      definition: definition(),
      producer: { id: 'other', kind: 'agent' },
      createdAt: '2026-10-18T00:00:00.000Z',
      parentDigest: first.version.digest,
    });
    expect(again.version).toEqual(first.version);
    expect(
      readWorkspaceLightAppDefinition({ ...input, entryId: 'admissions' }).versions
    ).toHaveLength(1);
    const retained = JSON.parse(readFileSync(path, 'utf8'));
    expect(retained.lightApps.versions[0].annotation).toBe('retained history');
    expect(retained.lightApps.versions[0].producer.annotation).toBe('retained actor');
    expect(retained.lightApps.entries[0].annotation).toBe('retained entry');
    importWorkspaceSkill({
      ...input,
      activate: false,
      expectedRevision: again.catalog.revision,
      id: 'catalog-guide',
      displayName: 'Catalog guide',
      producer,
      createdAt: '2026-10-17T00:00:00.000Z',
      tree: [
        {
          kind: 'file',
          path: 'SKILL.md',
          contentBase64: Buffer.from(
            '---\nname: catalog-guide\ndescription: Exercise shared catalog publication.\n---\n# Catalog guide\n'
          ).toString('base64'),
        },
      ],
    });
    expect(JSON.parse(readFileSync(path, 'utf8')).lightApps).toEqual(retained.lightApps);
  });

  it('refuses stale revisions, malformed definitions and missing parents before publication', () => {
    const input = fixture();
    const first = add(input);
    const path = catalogDocumentPath(input.dataRoot, input.workspaceId);
    const before = readFileSync(path, 'utf8');
    expect(() => add(input, 0, 'stale')).toThrow(CatalogConflictError);
    expect(() =>
      importWorkspaceLightAppDefinition({
        ...input,
        expectedRevision: 1,
        entryId: 'admissions',
        displayName: 'Admissions',
        definition: { ...definition(), script: 'run()' } as LightAppSchemaInput,
        producer,
        createdAt: '2026-10-18T00:00:00.000Z',
      })
    ).toThrow(CatalogInputError);
    const exported = exportWorkspaceLightAppDefinition({ ...input, entryId: 'admissions' });
    expect(() =>
      importWorkspaceLightAppDefinitionHistory({
        ...input,
        expectedRevision: 1,
        export: {
          ...exported,
          versions: [{ ...first.version, parentDigest: `sha256:${'f'.repeat(64)}` }],
        },
      })
    ).toThrow(CatalogInputError);
    expect(() =>
      importWorkspaceLightAppDefinitionHistory({
        ...input,
        expectedRevision: 1,
        export: {
          ...exported,
          versions: [{ ...first.version, digest: `sha256:${'f'.repeat(64)}` }],
        },
      })
    ).toThrow(CatalogInputError);
    expect(readFileSync(path, 'utf8')).toBe(before);
    const inactive = {
      ...fixture(),
      entryId: 'admissions',
      displayName: 'Admissions',
      producer,
      createdAt: '2026-10-17T00:00:00.000Z',
      selectDefault: false,
    };
    const root = importWorkspaceLightAppDefinition({
      ...inactive,
      expectedRevision: 0,
      definition: definition(),
    });
    const admitted = JSON.parse(root.version.definitionJson) as LightAppSchemaInput;
    const repeated = importWorkspaceLightAppDefinition({
      ...inactive,
      expectedRevision: root.catalog.revision,
      definition: admitted,
    });
    expect(repeated.version).toEqual(root.version);
    expect(repeated.catalog.lightApps.versions).toHaveLength(1);
    const inactivePath = catalogDocumentPath(inactive.dataRoot, inactive.workspaceId);
    const inactiveBefore = readFileSync(inactivePath, 'utf8');
    expect(() =>
      importWorkspaceLightAppDefinition({
        ...inactive,
        expectedRevision: repeated.catalog.revision,
        definition: { ...admitted, title: 'New revision' },
      })
    ).toThrow('Select a parent/default before importing a revision');
    expect(readFileSync(inactivePath, 'utf8')).toBe(inactiveBefore);
  });

  it('refuses malformed retained definitions and broken pin references on owner reads', () => {
    const input = fixture();
    const first = add(input);
    const path = catalogDocumentPath(input.dataRoot, input.workspaceId);
    const before = readFileSync(path, 'utf8');
    const malformed = '{"script":"run()"}';
    const bad = {
      ...first.catalog,
      lightApps: {
        ...first.catalog.lightApps,
        versions: [
          {
            ...first.version,
            definitionJson: malformed,
            digest: `sha256:${createHash('sha256').update(malformed).digest('hex')}`,
          },
        ],
      },
    };
    writeFileSync(path, JSON.stringify(bad));
    expect(() => loadWorkspaceResourceCatalog(input.dataRoot, input.workspaceId)).toThrow(
      CatalogIntegrityError
    );
    const broken = JSON.parse(before);
    broken.lightApps.pins = [{ entryId: 'admissions', digest: `sha256:${'e'.repeat(64)}` }];
    writeFileSync(path, JSON.stringify(broken));
    expect(() => loadWorkspaceResourceCatalog(input.dataRoot, input.workspaceId)).toThrow(
      CatalogIntegrityError
    );
  });

  it('bounds multibyte definition bytes before catalog publication', () => {
    const input = fixture();
    add(input);
    const path = catalogDocumentPath(input.dataRoot, input.workspaceId);
    const before = readFileSync(path, 'utf8');
    expect(() =>
      importWorkspaceLightAppDefinition({
        ...input,
        expectedRevision: 1,
        entryId: 'admissions',
        displayName: 'Admissions',
        definition: { ...definition(), purpose: '界'.repeat(90_000) },
        producer,
        createdAt: '2026-10-18T00:00:00.000Z',
      })
    ).toThrow(CatalogInputError);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('carries exact definition history through the verified Workspace export and import reader', () => {
    const input = fixture();
    const first = add(input);
    const second = add(input, first.catalog.revision, 'Admissions v2');
    const exportRoot = join(input.dataRoot, 'export');
    const timestamp = '2026-10-17T00:00:00.000Z';
    writeWorkspaceExportTree({
      exportRoot,
      exportId: 'wsexp_00000000-0000-7693-ae39-6c3f6020c3c4',
      sourceDeploymentId: 'dep_00000000-0000-7737-8fe7-61ca07c79d45',
      createdAt: timestamp,
      workspace: {
        id: workspaceId,
        name: 'Definition templates',
        kind: 'general',
        status: 'active',
        counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      threads: [],
      turns: [],
      knowledge: [],
      itemRevisions: [],
      artifacts: [],
      artifactReviews: [],
      threadMaterialBindings: [],
      workspaceMaterialRevisions: [],
      workspaceMaterials: [],
      agentSessions: [],
      turnEvents: [],
      portableFileState: {
        claims: new Map(),
        conflicts: new Map(),
        nativeKnowledgePages: new Map(),
        observations: new Map(),
        retrievalTraceFiles: new Map(),
        workerContextPackageFiles: new Map(),
        workspaceConfig: JSON.stringify({
          schemaVersion: 1,
          workspace: { name: 'Definition templates', defaultAgentId: null },
        }),
        workspaceSchema: null,
      },
      agentResourceCatalog: projectWorkspaceCatalogExport(input.dataRoot, input.workspaceId),
    });
    const imported = readWorkspaceImportSnapshot({
      verified: verifyWorkspaceExportTree({ exportRoot }),
      targetWorkspaceId: 'ws_00000000-0000-7000-8000-000000000002',
      targetServerId: 'server_test_target',
    });
    expect(imported.agentResourceCatalog?.lightApps.versions).toEqual([
      first.version,
      second.version,
    ]);
    expect(imported.agentResourceCatalog?.lightApps.entries[0].currentDigest).toBeNull();
    expect(imported.agentResourceCatalog?.lightApps.pins).toEqual([]);
    expect(imported.lightApps).toEqual([]);
    expect(imported.lightAppRecords).toEqual([]);
  });

  it('round-trips inline definitions through the existing Workspace catalog portability path', () => {
    const input = fixture();
    const first = add(input);
    const second = add(input, first.catalog.revision, 'Admissions v2');
    setWorkspaceLightAppDefinitionPin({
      ...input,
      expectedRevision: second.catalog.revision,
      entryId: 'admissions',
      digest: first.version.digest,
    });
    const projection = projectWorkspaceCatalogExport(input.dataRoot, input.workspaceId);
    const portable = readPortableAgentResourceCatalog(JSON.stringify(projection.catalog));
    expect(portable.lightApps.entries[0].sourceCurrentDigest).toBe(second.version.digest);
    expect(portable.lightApps.pins[0].digest).toBe(first.version.digest);
    const reconstructed = reconstructImportedWorkspaceCatalog(portable, new Map());
    const target = fixture();
    writeImportedWorkspaceCatalog(
      join(target.dataRoot, 'workspaces', target.workspaceId),
      reconstructed,
      []
    );
    const read = readWorkspaceLightAppDefinition({ ...target, entryId: 'admissions' });
    expect(read.versions).toEqual([first.version, second.version]);
    expect(read.entry.currentDigest).toBeNull();
    expect(read.pin).toBeNull();
    expect(
      resolveWorkspaceLightAppDefinition({
        ...target,
        entryId: 'admissions',
        digest: first.version.digest,
      }).definition
    ).toEqual(JSON.parse(first.version.definitionJson));
  });
});
