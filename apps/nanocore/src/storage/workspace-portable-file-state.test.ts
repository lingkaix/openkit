import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  KnowledgeRetrievalResponseSchema,
  WorkspaceExportResponseSchema,
  WorkspaceImportResponseSchema,
} from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { ensureLocalUser } from '../auth/identity.js';
import { FsStore } from '../lib/store.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';
import { verifyWorkspaceExportTree } from './workspace-export.js';
import { readWorkspaceImportSnapshot } from './workspace-import.js';

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

describe('workspace portable file state', () => {
  it('preserves authoritative workspace files, append history, and reminted references', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-portable-files-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    const sourceWorkspaceId = 'ws_demo';
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: sourceWorkspaceId,
    });
    const sourceRoot = join(dataRoot, 'workspaces', sourceWorkspaceId);
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
    const workspaceConfig = [
      '{',
      '  // This workspace-local policy comment must survive transfer.',
      '  "schemaVersion": 1,',
      '  "workspace": {',
      '    "name": "Demo Workspace",',
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
      'allowed_review_states: ["accepted", "user-authored"]',
      'allowed_sensitivities: ["normal", "confidential"]',
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
      'review_state: "user-authored"',
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

    const knowledgePageBytes = readFileSync(
      join(sourceRoot, 'knowledge', 'pages', `${knowledge.id}.md`),
      'utf8'
    );
    const knowledgeReference = `knowledge:${knowledge.id}@sha256:${createHash('sha256')
      .update(knowledgePageBytes)
      .digest('hex')}`;
    const acceptedPageId = 'portable-accepted-proposal';
    const acceptedPageBytes = [
      '---',
      'type: "KnowledgePage"',
      'title: "Portable accepted proposal"',
      'schema_version: "openkit-workspace-knowledge-schema-v1"',
      'status: "active"',
      'scope: "workspace"',
      `openkit_entry_id: "${acceptedPageId}"`,
      'openkit_entry_kind: "project-context"',
      `source_refs: ${JSON.stringify([knowledgeReference])}`,
      'review_state: "accepted"',
      'sensitivity: "normal"',
      'freshness: "current"',
      `created_at: "${firstTimestamp}"`,
      `updated_at: "${secondTimestamp}"`,
      '---',
      'Exact accepted proposal bytes survive portable transfer.',
      '',
    ].join('\n');
    const acceptedPageDigest = `sha256:${createHash('sha256')
      .update(acceptedPageBytes)
      .digest('hex')}`;
    const acceptedProposal = store.createKnowledgeProposal({
      workspaceId: sourceWorkspaceId,
      requestId: '00000000-0000-4000-8000-00000000d911',
      knowledgePageId: acceptedPageId,
      canonicalPageBytes: acceptedPageBytes,
      contentDigest: acceptedPageDigest,
      sourceReferences: [knowledgeReference],
      rationale: 'Preserve the exact reviewed page as portable Knowledge.',
      confidence: 1,
      verifiedExternalReferences: [],
      producer: { kind: 'agent', id: 'agent_knowledge', responsibleUserId: 'user_local' },
      createdAt: firstTimestamp,
    });
    store.recordKnowledgeProposalReviewDecision({
      workspaceId: sourceWorkspaceId,
      proposalId: acceptedProposal.id,
      requestId: '00000000-0000-4000-8000-00000000d912',
      decision: 'accepted',
      verifiedExternalReferences: [],
      actor: { kind: 'user', id: 'user_local' },
      decidedAt: secondTimestamp,
    });

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
        knowledgePageId: 'portable-file',
        sourceReferences: [`knowledge:${knowledge.id}`],
      }),
    ]);

    const exportRes = await app.request(`/api/app/workspaces/${sourceWorkspaceId}/export`, {
      method: 'POST',
    });
    expect(exportRes.status, await exportRes.clone().text()).toBe(200);
    const exported = WorkspaceExportResponseSchema.parse(await exportRes.json());
    const verified = verifyWorkspaceExportTree({
      exportRoot: join(
        dataRoot,
        'server',
        'exports',
        'workspaces',
        sourceWorkspaceId,
        exported.exportId
      ),
    });
    const acceptedExportPath = `workspace-files/knowledge/pages/${acceptedPageId}.md`;
    expect(verified.fileContents.get(acceptedExportPath)).toBe(acceptedPageBytes);
    for (const [name, alter] of [
      ['missing', (files: Map<string, string>) => files.delete(acceptedExportPath)],
      [
        'contradictory',
        (files: Map<string, string>) =>
          files.set(
            acceptedExportPath,
            acceptedPageBytes.replace(
              'Exact accepted proposal bytes survive portable transfer.',
              'Contradictory page content must fail import.'
            )
          ),
      ],
      [
        'duplicate-record',
        (files: Map<string, string>) => {
          const records = files.get('records/knowledge.jsonl');
          if (!records) {
            throw new Error('Knowledge records are unavailable in the export fixture.');
          }
          files.set('records/knowledge.jsonl', `${records}${records.split('\n')[0]}\n`);
        },
      ],
    ] as const) {
      const fileContents = new Map(verified.fileContents);
      alter(fileContents);
      expect(
        () =>
          readWorkspaceImportSnapshot({
            verified: { ...verified, fileContents },
            targetWorkspaceId: `ws_${name}_page_import`,
          }),
        name
      ).toThrow(/Knowledge Page/i);
    }
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
    const importedRoot = join(dataRoot, 'workspaces', importedWorkspaceId);
    const importedKnowledge = store
      .listKnowledge(importedWorkspaceId)
      .find((entry) => entry.title === knowledge.title);
    const importedAcceptedKnowledge = store
      .listKnowledge(importedWorkspaceId)
      .find((entry) => entry.title === 'Portable accepted proposal');
    expect(importedKnowledge).toBeDefined();
    expect(importedAcceptedKnowledge).toBeDefined();
    if (!importedKnowledge || !importedAcceptedKnowledge) {
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

    const importedRetrievalRows = readOptionalJsonl(
      join(
        importedRoot,
        'knowledge',
        'traces',
        `${retrieval.createdAt.slice(0, 7).replace('-', '')}.jsonl`
      )
    );
    expect.soft(importedRetrievalRows).toEqual([
      expect.objectContaining({
        workspaceId: importedWorkspaceId,
        selected: [
          expect.objectContaining({
            knowledgePageId: 'portable-file',
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
    const importedAcceptedPagePath = join(
      importedRoot,
      'knowledge',
      'pages',
      `${importedAcceptedKnowledge.id}.md`
    );
    const expectedImportedAcceptedPageBytes = acceptedPageBytes
      .replaceAll(acceptedPageId, importedAcceptedKnowledge.id)
      .replaceAll(knowledge.id, importedKnowledge.id);
    expect
      .soft(
        existsSync(importedAcceptedPagePath) ? readFileSync(importedAcceptedPagePath, 'utf8') : null
      )
      .toBe(expectedImportedAcceptedPageBytes);
    expect(store.listKnowledgeProposals(importedWorkspaceId)).toEqual([]);
    expect(store.listKnowledgeProposalReviewDecisions(importedWorkspaceId)).toEqual([]);

    store.updateWorkspace(importedWorkspaceId, { name: 'Persist unrelated imported change' });
    expect(readFileSync(importedAcceptedPagePath, 'utf8')).toBe(expectedImportedAcceptedPageBytes);
    const restartedStore = new FsStore({ dataRoot });
    expect(
      restartedStore
        .listKnowledge(importedWorkspaceId)
        .some((entry) => entry.id === importedAcceptedKnowledge.id)
    ).toBe(true);
    expect(readFileSync(importedAcceptedPagePath, 'utf8')).toBe(expectedImportedAcceptedPageBytes);

    const importedRetrievalRes = await app.request(
      `/api/app/workspaces/${importedWorkspaceId}/knowledge/retrievals`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'Exact accepted proposal bytes', limit: 1 }),
      }
    );
    expect(importedRetrievalRes.status, await importedRetrievalRes.clone().text()).toBe(200);
    const importedRetrieval = KnowledgeRetrievalResponseSchema.parse(
      await importedRetrievalRes.json()
    );
    expect(importedRetrieval.selected).toEqual([
      expect.objectContaining({
        knowledgePageId: importedAcceptedKnowledge.id,
        sourceReferences: [knowledgeReference.replaceAll(knowledge.id, importedKnowledge.id)],
      }),
    ]);

    coreDb.sqlite.close();
  });
});
