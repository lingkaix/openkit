import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  KnowledgeManagerContextPackageTraceRecordSchema,
  KnowledgeManagerPrepareContextResponseSchema,
  KnowledgeRetrievalResponseSchema,
  MaterializeKnowledgeContextPackageResponseSchema,
  WorkspaceExportResponseSchema,
  WorkspaceImportResponseSchema,
} from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { ensureLocalUser } from '../auth/identity.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';
import { WORKSPACE_EXPORT_MANIFEST_FILE } from './workspace-export.js';

/**
 * Reads one optional JSONL fixture so a single red test can report every missing file family.
 *
 * @param path Canonical workspace JSONL path.
 * @returns Parsed rows, or an empty list when the file is absent.
 */
function readOptionalJsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) {
    return [];
  }

  const text = readFileSync(path, 'utf8').trim();
  return text ? text.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>) : [];
}

/** Clones one server-managed export under a new handle and aligns its manifest id. */
function cloneWorkspaceExport(sourceRoot: string, exportId: string): string {
  const exportRoot = join(sourceRoot, '..', exportId);
  cpSync(sourceRoot, exportRoot, { recursive: true, errorOnExist: true });
  const manifestPath = join(exportRoot, WORKSPACE_EXPORT_MANIFEST_FILE);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, id: exportId }, null, 2)}\n`);
  return exportRoot;
}

/** Replaces or adds one inventoried export file and recomputes both inventory digests. */
function writeInventoriedExportFile(exportRoot: string, exportPath: string, content: string): void {
  const path = join(exportRoot, ...exportPath.split('/'));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  const manifestPath = join(exportRoot, WORKSPACE_EXPORT_MANIFEST_FILE);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    contentDigest: string;
    contentInventory: Array<{ path: string; digest: string; bytes: number }>;
  };
  let entry = manifest.contentInventory.find((candidate) => candidate.path === exportPath);
  if (!entry) {
    entry = { path: exportPath, digest: '', bytes: 0 };
    manifest.contentInventory.push(entry);
  }
  entry.bytes = Buffer.byteLength(content);
  entry.digest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
  manifest.contentDigest = `sha256:${createHash('sha256')
    .update(JSON.stringify(manifest.contentInventory))
    .digest('hex')}`;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

describe('workspace portable file state', () => {
  it('preserves authoritative workspace files, append history, and reminted references', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-portable-files-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    const sourceWorkspaceId = 'ws_demo';
    const sourceRoot = join(dataRoot, 'users', 'user_local', 'workspaces', sourceWorkspaceId);
    const firstTimestamp = '2026-07-06T00:00:00.000Z';
    const secondTimestamp = '2026-07-06T00:00:01.000Z';
    const knowledge = store.createKnowledgeEntry(sourceWorkspaceId, {
      kind: 'project-context',
      title: 'Portable contract',
      content: 'Portable contract evidence survives workspace transfer.',
      sourceReferences: [],
    });

    store.recordKnowledgeObservation({
      id: 'ko_portable_first',
      workspaceId: sourceWorkspaceId,
      kind: 'maintenance',
      summary: 'First portable observation.',
      sourceReferences: ['claim:kc_portable_source'],
      scope: 'workspace',
      producer: 'portability-test',
      confidence: 0.9,
      freshness: 'current',
      status: 'retained',
      observedAt: firstTimestamp,
      createdAt: firstTimestamp,
    });
    store.recordKnowledgeObservation({
      id: 'ko_portable_second',
      workspaceId: sourceWorkspaceId,
      kind: 'maintenance',
      summary: 'Second portable observation.',
      sourceReferences: ['claim:kc_portable_source'],
      scope: 'workspace',
      producer: 'portability-test',
      confidence: 1,
      freshness: 'current',
      status: 'promoted',
      observedAt: secondTimestamp,
      createdAt: secondTimestamp,
    });
    store.recordKnowledgeClaim({
      id: 'kc_portable_first',
      workspaceId: sourceWorkspaceId,
      statement: 'First portable claim.',
      sourceReferences: [`knowledge:${knowledge.id}`],
      scope: 'workspace',
      producer: 'portability-test',
      confidence: 0.8,
      freshness: 'current',
      reviewState: 'accepted',
      conflictStatus: 'none',
      createdAt: firstTimestamp,
      updatedAt: firstTimestamp,
    });
    store.recordKnowledgeClaim({
      id: 'kc_portable_source',
      workspaceId: sourceWorkspaceId,
      statement: 'Source-backed portable claim.',
      sourceReferences: [`knowledge:${knowledge.id}`],
      scope: 'workspace',
      producer: 'portability-test',
      confidence: 1,
      freshness: 'current',
      reviewState: 'accepted',
      conflictStatus: 'none',
      createdAt: secondTimestamp,
      updatedAt: secondTimestamp,
    });
    store.recordKnowledgeConflict({
      id: 'kf_portable',
      workspaceId: sourceWorkspaceId,
      subjectReferences: [`knowledge:${knowledge.id}`, 'claim:kc_portable_source'],
      sourceReferences: [`knowledge:${knowledge.id}`],
      status: 'needs_review',
      summary: 'Portable conflict needs review.',
      suggestedActions: ['Resolve the portable conflict.'],
      producer: 'portability-test',
      createdAt: firstTimestamp,
      updatedAt: firstTimestamp,
    });
    store.resolveKnowledgeConflict({
      workspaceId: sourceWorkspaceId,
      conflictId: 'kf_portable',
      status: 'resolved',
      resolution: 'Portable conflict resolved.',
      resolvedBy: 'portability-test',
      resolvedAt: secondTimestamp,
    });
    store.createKnowledgeProposal({
      id: 'kp_portable_source_claim',
      workspaceId: sourceWorkspaceId,
      title: 'Promote portable claim',
      summary: 'The imported claim must remain usable by proposal review.',
      sourceClaimId: 'kc_portable_source',
      status: 'pending',
      createdAt: secondTimestamp,
      updatedAt: secondTimestamp,
    });

    const workspaceConfig = [
      '{',
      '  // This workspace-local policy comment must survive transfer.',
      '  "schemaVersion": 1,',
      '  "workspace": {',
      '    "roots": [],',
      '    "assistant": { "repositoryInspection": { "enabled": false } }',
      '  }',
      '}',
      '',
    ].join('\n');
    const workspaceSchema = [
      'schema_version: "openkit-workspace-knowledge-schema-v1"',
      'status: "active"',
      'allowed_types: ["KnowledgePage", "RepoConvention"]',
      'allowed_statuses: ["active"]',
      'allowed_review_states: ["accepted"]',
      'allowed_sensitivities: ["normal"]',
      'allowed_freshness: ["current"]',
      '',
    ].join('\n');
    const portablePage = [
      '---',
      'type: "RepoConvention"',
      'title: "Portable file convention"',
      'schema_version: "openkit-workspace-knowledge-schema-v1"',
      'status: "active"',
      'scope: "workspace"',
      `source_refs: ["knowledge:${knowledge.id}"]`,
      'review_state: "accepted"',
      'sensitivity: "normal"',
      'freshness: "current"',
      `created_at: "${firstTimestamp}"`,
      `updated_at: "${secondTimestamp}"`,
      '---',
      'Portable file convention body.',
      '',
    ].join('\n');

    mkdirSync(join(sourceRoot, 'config'), { recursive: true });
    writeFileSync(join(sourceRoot, 'config', 'workspace.jsonc'), workspaceConfig);
    writeFileSync(
      join(sourceRoot, 'knowledge', 'schema', 'workspace-schema.yaml'),
      workspaceSchema
    );
    writeFileSync(join(sourceRoot, 'knowledge', 'pages', 'portable-file.md'), portablePage);

    const app = createApp({ coreDb, dataRoot, store });
    const retrievalRes = await app.request(
      `/api/app/workspaces/${sourceWorkspaceId}/knowledge/retrievals`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'portable file convention', limit: 1 }),
      }
    );
    expect(retrievalRes.status, await retrievalRes.clone().text()).toBe(200);
    const retrieval = KnowledgeRetrievalResponseSchema.parse(await retrievalRes.json());
    expect(retrieval.selected).toEqual([
      expect.objectContaining({
        path: 'knowledge/pages/portable-file.md',
        sourceReferences: [`knowledge:${knowledge.id}`],
      }),
    ]);

    const contextRes = await app.request(
      `/api/app/workspaces/${sourceWorkspaceId}/knowledge/manager/context`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'portable contract evidence' }),
      }
    );
    expect(contextRes.status, await contextRes.clone().text()).toBe(200);
    const context = KnowledgeManagerPrepareContextResponseSchema.parse(await contextRes.json());
    expect(context.packageTrace.selectedKnowledgeEntryIds).toContain(knowledge.id);
    store.createKnowledgeSource({
      id: context.packageTrace.contextPackageId,
      workspaceId: sourceWorkspaceId,
      kind: 'document',
      title: 'Package id collision source',
      uri: null,
      contentDigest: 'sha256:package-id-collision',
      originatingThreadId: null,
      originatingTurnId: null,
      originatingFileId: null,
      capturedAt: secondTimestamp,
      createdAt: secondTimestamp,
      updatedAt: secondTimestamp,
    });
    const materializeRes = await app.request(
      `/api/app/workspaces/${sourceWorkspaceId}/knowledge/manager/context/${context.packageTrace.contextPackageId}/materialization`,
      { method: 'POST' }
    );
    expect(materializeRes.status, await materializeRes.clone().text()).toBe(200);
    MaterializeKnowledgeContextPackageResponseSchema.parse(await materializeRes.json());

    const exportRes = await app.request(`/api/app/workspaces/${sourceWorkspaceId}/export`, {
      method: 'POST',
    });
    expect(exportRes.status, await exportRes.clone().text()).toBe(200);
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());
    const exportRoot = join(
      dataRoot,
      'server',
      'exports',
      'workspaces',
      sourceWorkspaceId,
      exported.exportId
    );
    const tracePath = 'records/knowledge-context-package-traces.jsonl';
    const sourceTrace = JSON.parse(
      readFileSync(join(exportRoot, ...tracePath.split('/')), 'utf8').trim()
    ) as Record<string, unknown>;
    const invalidTraceExportId = 'wsexp_invalid_source_context_digest';
    const invalidTraceRoot = cloneWorkspaceExport(exportRoot, invalidTraceExportId);
    writeInventoriedExportFile(
      invalidTraceRoot,
      tracePath,
      `${JSON.stringify({
        ...sourceTrace,
        response: {
          ...(sourceTrace.response as Record<string, unknown>),
          packageTrace: {
            ...((sourceTrace.response as { packageTrace: Record<string, unknown> }).packageTrace ??
              {}),
            contextPackageDigest: `ctxpkg_sha256_${'f'.repeat(64)}`,
          },
        },
      })}\n`
    );
    const invalidTraceImport = await app.request('/api/app/workspace-imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceWorkspaceId,
        exportId: invalidTraceExportId,
        requestId: '00000000-0000-4000-8000-00000000d911',
      }),
    });
    expect(invalidTraceImport.status).toBe(400);

    const contextPackageId = context.packageTrace.contextPackageId;
    const materializationPrefix = `workspace-files/knowledge/context-materializations/${contextPackageId}/openkit/context`;
    const packagePath = `${materializationPrefix}/package.json`;
    const sourceManifest = JSON.parse(
      readFileSync(join(exportRoot, ...packagePath.split('/')), 'utf8')
    ) as Record<string, unknown>;
    const invalidManifestExportId = 'wsexp_invalid_materialization_digest';
    const invalidManifestRoot = cloneWorkspaceExport(exportRoot, invalidManifestExportId);
    writeInventoriedExportFile(
      invalidManifestRoot,
      packagePath,
      `${JSON.stringify(
        { ...sourceManifest, contextPackageDigest: `ctxpkg_sha256_${'e'.repeat(64)}` },
        null,
        2
      )}\n`
    );
    const invalidManifestImport = await app.request('/api/app/workspace-imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceWorkspaceId,
        exportId: invalidManifestExportId,
        requestId: '00000000-0000-4000-8000-00000000d912',
      }),
    });
    expect(invalidManifestImport.status).toBe(400);

    const unlistedExportId = 'wsexp_unlisted_materialization_file';
    const unlistedRoot = cloneWorkspaceExport(exportRoot, unlistedExportId);
    writeInventoriedExportFile(
      unlistedRoot,
      `${materializationPrefix}/unlisted.txt`,
      'This file is absent from the package manifest.\n'
    );
    const unlistedImport = await app.request('/api/app/workspace-imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceWorkspaceId,
        exportId: unlistedExportId,
        requestId: '00000000-0000-4000-8000-00000000d913',
      }),
    });
    expect(unlistedImport.status).toBe(400);

    const sourceEntries = sourceManifest.entries as unknown[];
    const duplicateEntry = sourceEntries[0];
    if (!duplicateEntry) {
      throw new Error('Expected a materialization manifest entry.');
    }
    const duplicateEntryExportId = 'wsexp_duplicate_materialization_entry';
    const duplicateEntryRoot = cloneWorkspaceExport(exportRoot, duplicateEntryExportId);
    writeInventoriedExportFile(
      duplicateEntryRoot,
      packagePath,
      `${JSON.stringify(
        { ...sourceManifest, entries: [...sourceEntries, duplicateEntry] },
        null,
        2
      )}\n`
    );
    const duplicateEntryImport = await app.request('/api/app/workspace-imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceWorkspaceId,
        exportId: duplicateEntryExportId,
        requestId: '00000000-0000-4000-8000-00000000d914',
      }),
    });
    expect(duplicateEntryImport.status).toBe(400);

    const importRes = await app.request('/api/app/workspace-imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceWorkspaceId,
        exportId: exported.exportId,
        requestId: '00000000-0000-4000-8000-00000000d901',
      }),
    });
    expect(importRes.status, await importRes.clone().text()).toBe(200);
    const imported = WorkspaceImportResponseSchema.parse(await importRes.json());
    const importedWorkspaceId = imported.importedWorkspaceId;
    const importedRoot = join(dataRoot, 'users', 'user_local', 'workspaces', importedWorkspaceId);
    const importedKnowledge = store
      .listKnowledge(importedWorkspaceId)
      .find((entry) => entry.title === knowledge.title);
    expect(importedKnowledge).toBeDefined();
    if (!importedKnowledge) {
      coreDb.sqlite.close();
      return;
    }

    const observationRows = readOptionalJsonl(
      join(importedRoot, 'knowledge', 'observations', '202607.jsonl')
    );
    expect
      .soft(observationRows.map((row) => row.summary))
      .toEqual(['First portable observation.', 'Second portable observation.']);
    expect
      .soft(observationRows.map((row) => row.workspaceId))
      .toEqual([importedWorkspaceId, importedWorkspaceId]);

    const claimRows = readOptionalJsonl(join(importedRoot, 'knowledge', 'claims', '202607.jsonl'));
    expect
      .soft(claimRows.map((row) => row.statement))
      .toEqual(['First portable claim.', 'Source-backed portable claim.']);
    expect
      .soft(claimRows.map((row) => row.workspaceId))
      .toEqual([importedWorkspaceId, importedWorkspaceId]);
    expect
      .soft(claimRows.map((row) => row.sourceReferences))
      .toEqual([[`knowledge:${importedKnowledge.id}`], [`knowledge:${importedKnowledge.id}`]]);
    const importedSourceClaim = claimRows.find(
      (row) => row.statement === 'Source-backed portable claim.'
    );
    expect.soft(importedSourceClaim?.id).toEqual(expect.any(String));

    const conflictRows = readOptionalJsonl(
      join(importedRoot, 'knowledge', 'conflicts', '202607.jsonl')
    );
    expect.soft(conflictRows.map((row) => row.status)).toEqual(['needs_review', 'resolved']);
    expect
      .soft(conflictRows.map((row) => row.workspaceId))
      .toEqual([importedWorkspaceId, importedWorkspaceId]);
    expect.soft(conflictRows[1]).toMatchObject({
      resolution: 'Portable conflict resolved.',
      sourceReferences: [`knowledge:${importedKnowledge.id}`],
      subjectReferences: [
        `knowledge:${importedKnowledge.id}`,
        `claim:${String(importedSourceClaim?.id)}`,
      ],
    });

    const importedContextRows = readOptionalJsonl(
      join(importedRoot, 'knowledge', 'context-packages', '202607.jsonl')
    );
    const importedContextTrace = importedContextRows[0]
      ? KnowledgeManagerContextPackageTraceRecordSchema.parse(importedContextRows[0])
      : null;
    expect.soft(importedContextRows).toHaveLength(1);
    expect.soft(importedContextRows[0]).toMatchObject({
      workspaceId: importedWorkspaceId,
      response: {
        workspaceId: importedWorkspaceId,
        packageTrace: {
          selectedKnowledgeEntryIds: expect.arrayContaining([importedKnowledge.id]),
        },
        claims: expect.arrayContaining([
          expect.objectContaining({
            id: importedSourceClaim?.id,
            sourceReferences: [`knowledge:${importedKnowledge.id}`],
          }),
        ]),
      },
    });

    const importedRetrievalRows = readOptionalJsonl(
      join(importedRoot, 'knowledge', 'traces', '202607.jsonl')
    );
    expect.soft(importedRetrievalRows).toEqual([
      expect.objectContaining({
        workspaceId: importedWorkspaceId,
        selected: [
          expect.objectContaining({
            path: 'knowledge/pages/portable-file.md',
            sourceReferences: [`knowledge:${importedKnowledge.id}`],
          }),
        ],
      }),
    ]);

    const importedConfigPath = join(importedRoot, 'config', 'workspace.jsonc');
    expect
      .soft(existsSync(importedConfigPath) ? readFileSync(importedConfigPath, 'utf8') : null)
      .toBe(workspaceConfig);
    const importedSchemaPath = join(importedRoot, 'knowledge', 'schema', 'workspace-schema.yaml');
    expect
      .soft(existsSync(importedSchemaPath) ? readFileSync(importedSchemaPath, 'utf8') : null)
      .toBe(workspaceSchema);
    const importedPagePath = join(importedRoot, 'knowledge', 'pages', 'portable-file.md');
    expect
      .soft(existsSync(importedPagePath) ? readFileSync(importedPagePath, 'utf8') : null)
      .toBe(portablePage.replace(`knowledge:${knowledge.id}`, `knowledge:${importedKnowledge.id}`));
    const importedNativePagePath = join(
      importedRoot,
      'knowledge',
      'pages',
      `${importedKnowledge.id}.md`
    );
    expect
      .soft(
        existsSync(importedNativePagePath) ? readFileSync(importedNativePagePath, 'utf8') : null
      )
      .toContain(`openkit_entry_id: "${importedKnowledge.id}"`);

    const materializationsRoot = join(importedRoot, 'knowledge', 'context-materializations');
    const importedContextPackageIds = existsSync(materializationsRoot)
      ? readdirSync(materializationsRoot)
      : [];
    const importedContextPackageId = importedContextTrace?.id;
    expect.soft(importedContextPackageIds).toEqual([importedContextPackageId]);
    const importedManifestPath = join(
      materializationsRoot,
      String(importedContextPackageId),
      'openkit',
      'context',
      'package.json'
    );
    const importedManifest = existsSync(importedManifestPath)
      ? (JSON.parse(readFileSync(importedManifestPath, 'utf8')) as Record<string, unknown>)
      : null;
    expect.soft(importedManifest).toMatchObject({
      workspaceId: importedWorkspaceId,
      contextPackageId: importedContextPackageId,
      contextPackageDigest: importedContextTrace?.response.packageTrace.contextPackageDigest,
      entries: expect.arrayContaining([
        expect.objectContaining({
          path: `/openkit/context/knowledge/${importedKnowledge.id}.md`,
          sourceReferences: expect.arrayContaining([`knowledge:${importedKnowledge.id}`]),
        }),
      ]),
    });
    expect
      .soft(importedContextTrace?.response.packageTrace.contextPackageDigest)
      .not.toBe(context.packageTrace.contextPackageDigest);
    const importedPolicyPath = join(
      materializationsRoot,
      String(importedContextPackageId),
      'openkit',
      'context',
      'policy.json'
    );
    const importedPolicy = existsSync(importedPolicyPath)
      ? (JSON.parse(readFileSync(importedPolicyPath, 'utf8')) as Record<string, unknown>)
      : null;
    expect.soft(importedPolicy).toMatchObject({
      claims: importedContextTrace?.response.claims,
      conflicts: importedContextTrace?.response.conflicts,
      packageTrace: importedContextTrace?.response.packageTrace,
      policy: importedContextTrace?.response.policy,
    });
    expect(
      (importedPolicy?.claims as Array<{ workspaceId?: string }> | undefined)?.every(
        (claim) => claim.workspaceId === importedWorkspaceId
      )
    ).toBe(true);
    expect(
      store.readKnowledgeContextPackageMaterialization(
        importedWorkspaceId,
        String(importedContextPackageId)
      )
    ).not.toBeNull();

    const importedProposal = store.listKnowledgeProposals(importedWorkspaceId)[0];
    expect.soft(importedProposal?.sourceClaimId).toBe(importedSourceClaim?.id);
    const decisionRes = await app.request(
      `/api/app/workspaces/${importedWorkspaceId}/knowledge/proposals/${importedProposal?.id}/decision`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: '00000000-0000-4000-8000-00000000d902',
          decision: 'accepted',
          message: 'Apply the imported source claim.',
        }),
      }
    );
    expect.soft(decisionRes.status, await decisionRes.clone().text()).toBe(200);
    expect
      .soft(
        store
          .listKnowledge(importedWorkspaceId)
          .find((entry) => entry.title === 'Source-backed portable claim.')
      )
      .toMatchObject({ sourceReferences: [`knowledge:${importedKnowledge.id}`] });

    coreDb.sqlite.close();
  });
});
