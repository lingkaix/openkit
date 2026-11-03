import { join } from 'node:path';
import type { PreviewKnowledgeSchemaResponse } from '@openkit/app-api-schemas';
import {
  canonicalJsonText,
  compareCodeUnits,
  formatReferenceUri,
  type RetrievalTraceReference,
  ThreadSchema,
  TurnSchema,
} from '@openkit/protocol';
import { sha256Hex } from '@openkit/protocol/digest';
import { readVerifiedThreadWorkerContextTraceSteps } from '../context/worker-context-projection.js';
import { resolveWorkspaceKnowledgeReferenceProofsSteps } from '../knowledge-source-authority.js';
import type { FsStore } from '../lib/store.js';
import { OperationError } from '../operation-error.js';
import { type KnowledgeRetrievalAccess, threadReadable } from '../retrieval-knowledge-adapter.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import { assertKnowledgeRetrievalTraceReadableSteps } from '../storage/index-rebuild.js';
import { readRetrievalTraceSteps } from '../storage/retrieval-traces.js';
import { readControlWorkObservations } from '../storage/work-observations.js';
import {
  nativeProductScope,
  readNativeProductPages,
  readNativeTurnHistorySteps,
  type readWorkspaceKnowledgeProposalInventory,
  readWorkspaceKnowledgeProposalInventorySteps,
  serializeKnowledgeProposalRecord,
  TurnReaderSchema,
} from '../storage/workspace-file-records.js';
import { NotebookError } from './notebook-error.js';
import { parseScopeKnowledgeSchema } from './okf.js';
import {
  previewNotebookSchemaContent,
  previewSchemaIndexImpact,
  schemaCandidateTreeNeedsReview,
} from './scope-schema-impact.js';
import type { previewNotebookSchema } from './scope-schema-migration.js';

type Inventory = PreviewKnowledgeSchemaResponse['dependencyInventory'][number];
type Proposal = ReturnType<
  typeof readWorkspaceKnowledgeProposalInventory
>['knowledgeProposals'][number];

/** Current caller and existing native readers; this composition has no publication authority. */
interface WorkspaceSchemaPreviewInput extends Omit<ParametersShape, 'revalidate'> {
  /** Native callers delegate released authority contributions; sync callers return directly. */
  readonly revalidate: () => void | Generator<void, void, void>;
  readonly dataRoot: string;
  readonly coreDb: CoreDb;
  readonly store: FsStore;
  readonly workspaceDb: WorkspaceDb;
  readonly access: KnowledgeRetrievalAccess;
  /** Admit both complete retained Proposal trees through the existing Notebook publication owner. */
  readonly admitProposal: (proposal: Proposal) => void | Generator<void, void, void>;
}
type ParametersShape = Parameters<typeof previewNotebookSchema>[0];

/**
 * Inspects the observed admitted Workspace dependency set without changing any retained record.
 * Two matching scans detect observed changes, not a global atomic snapshot or migration readiness.
 */
export function previewWorkspaceSchema(
  input: WorkspaceSchemaPreviewInput
): PreviewKnowledgeSchemaResponse {
  const steps = previewWorkspaceSchemaSteps(input);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/** Shares complete owner contributions with native preparation, with no SQL cut across a yield. */
export function* previewWorkspaceSchemaSteps(
  input: WorkspaceSchemaPreviewInput
): Generator<void, PreviewKnowledgeSchemaResponse, void> {
  const revision = input.notebook.publishedRevision();
  const currentFiles = input.notebook.readContent(revision);
  const notebook = previewNotebookSchemaContent({
    workspaceId: input.workspaceId,
    notebookRevision: revision,
    files: currentFiles,
    scopeSchemaText: input.scopeSchemaText,
    candidateSchemaText: input.candidateSchemaText,
    pageScopeId: input.pageScopeId,
    registeredSources: input.registeredSources,
  });
  const workspaceRoot = join(input.dataRoot, 'workspaces', input.workspaceId);
  const candidate = parseScopeKnowledgeSchema(input.candidateSchemaText);
  const indexImpact = previewSchemaIndexImpact({
    files: currentFiles,
    scopeSchemaText: input.scopeSchemaText,
    candidateSchemaText: input.candidateSchemaText,
    pageScopeId: input.pageScopeId,
    registeredSources: input.registeredSources,
  });
  const changedPages = new Set(
    notebook.records.filter((row) => row.status !== 'valid').map((row) => row.path.slice(0, -3))
  );
  const digest = (value: unknown) => `sha256:${sha256Hex(canonicalJsonText(value))}`;

  function* inspect() {
    const rows: Inventory[] = ['maintenance', 'proposals', 'indexes', 'trace-references'].map(
      (family) => ({
        family: family as Inventory['family'],
        complete: true,
        records: [],
        diagnostics: [],
      })
    );
    const [maintenance, proposals, indexes, traces] = rows as [
      Inventory,
      Inventory,
      Inventory,
      Inventory,
    ];
    const facts = new Map(rows.map((row) => [row.family, [] as unknown[]]));
    const hiddenAvailability = new Set<Inventory['family']>();
    const unavailable = (row: Inventory) => {
      row.complete = false;
      if (!row.diagnostics.length) row.diagnostics.push({ code: 'schema.inventory_unavailable' });
    };
    const discloseTrace = function* (
      reference: RetrievalTraceReference,
      fact: unknown
    ): Generator<void, boolean, void> {
      try {
        yield* assertKnowledgeRetrievalTraceReadableSteps({
          dataRoot: input.dataRoot,
          workspaceId: input.workspaceId,
          access: input.access,
          retrievalTraceRef: reference,
        });
        return true;
      } catch (error) {
        if (!(error instanceof OperationError) || error.code !== 'knowledge_source_unavailable')
          throw error;
        // Known target absence is not corruption. Full projection remains denied, so no
        // protected record identity, count or digest is returned with this completed outcome.
        hiddenAvailability.add(traces.family);
        facts.get(traces.family)!.push(fact);
        if (!traces.diagnostics.some((row) => row.code === 'schema.references_unavailable'))
          traces.diagnostics.push({ code: 'schema.references_unavailable' });
        return false;
      }
    };
    const record = (row: Inventory, id: string, needsReview: boolean, fact: unknown) => {
      row.records.push({
        id,
        status: needsReview ? 'needs-review' : 'valid',
        diagnostics: needsReview ? [{ code: 'schema.eligibility_changed' }] : [],
      });
      facts.get(row.family)!.push(fact);
    };
    for (const { id, needsReview, before, after } of indexImpact) {
      record(indexes, id, needsReview, { id, before, after });
      yield;
    }

    try {
      const inventory = yield* readWorkspaceKnowledgeProposalInventorySteps(
        workspaceRoot,
        input.workspaceId,
        input.workspaceDb
      );
      for (const proposal of inventory.knowledgeProposals) {
        yield;
        try {
          const admission = input.admitProposal(proposal);
          if (admission) yield* admission;
          const files = input.notebook.readContent(proposal.candidateRevision);
          const affected = schemaCandidateTreeNeedsReview({
            workspaceId: input.workspaceId,
            files,
            candidateSchemaText: input.candidateSchemaText,
          });
          record(proposals, proposal.id, affected, serializeKnowledgeProposalRecord(proposal));
          for (const review of inventory.knowledgeProposalReviews.filter(
            (row) => row.proposalId === proposal.id
          ))
            record(proposals, review.reviewId, affected, review);
        } catch {
          unavailable(proposals);
        }
      }
    } catch {
      unavailable(proposals);
    }

    try {
      const scope = {
        ...nativeProductScope(input.dataRoot, {
          kind: 'workspace',
          workspaceId: input.workspaceId,
        }),
        sqlite: input.workspaceDb.sqlite,
      };
      const threads: ReturnType<typeof ThreadSchema.parse>[] = [];
      for (const page of readNativeProductPages(scope, 'thread')) {
        threads.push(...page.map((row) => ThreadSchema.parse(row.record)));
        yield;
      }
      function* readTurn(threadId: string, turnId: string) {
        const history = yield* readNativeTurnHistorySteps(scope, turnId);
        if (
          !history ||
          history.turn.owner.kind !== 'workspace' ||
          history.turn.owner.workspaceId !== input.workspaceId ||
          history.turn.threadId !== threadId
        )
          throw new Error('Unavailable source Turn.');
        return TurnSchema.parse(TurnReaderSchema.parse(history.turn));
      }
      // An unreadable container prevents a complete census without disclosing its identity or size.
      for (const thread of threads) {
        yield;
        if (!threadReadable({ workspaceId: input.workspaceId, access: input.access }, thread.id)) {
          unavailable(maintenance);
          unavailable(traces);
          continue;
        }
        try {
          // Metadata discovers maintenance and trace candidates without loading unrelated Item histories.
          input.store.getThread(input.workspaceId, thread.id);
          const turns: ReturnType<FsStore['getTurnMetadata']>[] = [];
          for (const page of readNativeProductPages(scope, 'turn')) {
            for (const row of page) {
              if (row.record.threadId !== thread.id) continue;
              const { items: _items, ...metadata } = TurnReaderSchema.parse({
                ...row.record,
                items: [],
              });
              turns.push(metadata);
            }
            yield;
          }
          turns.sort((a, b) => compareCodeUnits(a.startedAt ?? '', b.startedAt ?? ''));
          for (const turn of turns) {
            yield;
            const knowledge = turn.internalExecution?.knowledge;
            const isMaintenance =
              (knowledge?.purpose === 'maintenance' &&
                knowledge.ownerScope.kind === 'workspace' &&
                knowledge.ownerScope.workspaceId === input.workspaceId) ||
              (turn.agentId === 'knowledge-manager' &&
                ((turn.triggerSource?.kind === 'automation' &&
                  turn.triggerSource.summary === 'Knowledge Manager scheduled maintenance.') ||
                  (turn.triggerSource?.kind === 'system-input' &&
                    turn.triggerSource.summary === 'Knowledge maintenance.')));
            if (!isMaintenance) continue;
            try {
              const completeTurn = yield* readTurn(thread.id, turn.id);
              for (const range of knowledge?.sourceRange ?? []) {
                if (
                  !threadReadable(
                    { workspaceId: input.workspaceId, access: input.access },
                    range.threadId
                  )
                )
                  throw new Error('Unavailable source owner.');
                const source = yield* readTurn(range.threadId, range.turnId);
                const first = source.items.findIndex((item) => item.id === range.firstItemId);
                const last = source.items.findIndex((item) => item.id === range.lastItemId);
                if (first < 0 || last < first) throw new Error('Unavailable source range.');
              }
              if (knowledge?.askingThreadId) {
                if (
                  !threadReadable(
                    { workspaceId: input.workspaceId, access: input.access },
                    knowledge.askingThreadId
                  )
                )
                  throw new Error('Unavailable asking owner.');
                input.store.getThread(input.workspaceId, knowledge.askingThreadId);
                if (knowledge.askingTurnId)
                  yield* readTurn(knowledge.askingThreadId, knowledge.askingTurnId);
              }
              const observations: Array<ReturnType<typeof readControlWorkObservations>[number]> =
                [];
              let afterSequence = 0;
              for (;;) {
                const page = readControlWorkObservations(
                  input.workspaceDb.sqlite,
                  { kind: 'workspace', workspaceId: input.workspaceId },
                  { threadId: thread.id, turnId: turn.id, afterSequence }
                );
                observations.push(...page);
                yield;
                if (page.length < 128) break;
                afterSequence = page.at(-1)!.seq;
              }
              // Maintenance and observation payloads retain their fixed native schemas; they are not OKF Pages.
              record(maintenance, turn.id, false, { turn: completeTurn, observations });
            } catch {
              unavailable(maintenance);
            }
          }
          const retained = yield* readRetrievalTraceSteps(
            workspaceRoot,
            `retrieval-trace/thread/${input.workspaceId}/${thread.id}`
          );
          for (const turn of turns)
            retained.push(
              ...(yield* readRetrievalTraceSteps(
                workspaceRoot,
                `retrieval-trace/turn/${input.workspaceId}/${thread.id}/${turn.id}`
              ))
            );
          for (const { reference, trace } of retained) {
            yield;
            if (
              'sourceKind' in trace ||
              trace.sourceScope !== input.pageScopeId ||
              trace.retrievalParameters.sourceScope !== 'workspace'
            )
              continue;
            try {
              // Current containing/Source admission precedes any Page or work-history dereference.
              if (!(yield* discloseTrace(reference, trace))) continue;
              if (trace.notebookRevision === null) throw new Error('Missing native revision.');
              const entries = [...trace.selected, ...trace.excluded];
              const proofs = yield* resolveWorkspaceKnowledgeReferenceProofsSteps({
                coreDb: input.coreDb,
                store: input.store,
                workspaceDb: input.workspaceDb,
                workspaceId: input.workspaceId,
                notebookRevision: trace.notebookRevision,
                pageIds: [...new Set(entries.map((entry) => entry.reference.objectId))],
              });
              for (const entry of entries) {
                const proof = proofs.get(entry.reference.objectId);
                // A missing proof can be current unavailability. A contradictory existing proof cannot.
                if (
                  proof &&
                  ((entry.revision !== null && entry.revision !== trace.notebookRevision) ||
                    (entry.contentDigest !== null && entry.contentDigest !== proof.contentDigest) ||
                    digest(entry.sourceReferences) !== digest(proof.sourceReferences))
                )
                  throw new Error('Native reference proof is contradictory.');
              }
              const needsReview =
                entries.some((entry) => {
                  const proof = proofs.get(entry.reference.objectId);
                  if (!proof && (entry.revision !== null || entry.contentDigest !== null))
                    throw new Error('Native reference proof is unavailable.');
                  return (
                    changedPages.has(entry.reference.objectId) ||
                    !Object.hasOwn(currentFiles, `${entry.reference.objectId}.md`)
                  );
                }) || !candidate.ok;
              record(traces, formatReferenceUri(reference), needsReview, trace);
            } catch {
              unavailable(traces);
            }
          }
          try {
            const verified = yield* readVerifiedThreadWorkerContextTraceSteps({
              coreDb: input.coreDb,
              store: input.store,
              workspaceDb: input.workspaceDb,
              threadId: thread.id,
            });
            for (const { trace } of verified) {
              yield;
              const relevant = [...trace.knowledgeSelections, ...trace.knowledgeExclusions].filter(
                (entry) =>
                  input.pageScopeId ===
                  `page/workspace/${input.workspaceId}/${entry.knowledgeBaseId}`
              );
              if (!relevant.length) continue;
              // Only the admitted containing identity is disclosed, never other scopes' selections or digest preimages.
              const retrieval = trace.knowledgeSelectionInput?.retrievalTraceRef;
              if (!retrieval) {
                unavailable(traces);
                continue;
              }
              const source = retained.find(
                ({ reference }) => formatReferenceUri(reference) === formatReferenceUri(retrieval)
              );
              if (
                !source ||
                'sourceKind' in source.trace ||
                source.trace.sourceScope !== input.pageScopeId
              ) {
                unavailable(traces);
                continue;
              }
              if (
                !(yield* discloseTrace(retrieval, {
                  turnId: trace.turnId,
                  contextPackageDigest: trace.contextPackageDigest,
                }))
              )
                continue;
              // S39 exclusions are S61-selected Pages omitted by the package budget, not
              // retrieval-policy exclusions; both must retain the selected row's exact tuple.
              for (const entry of relevant) {
                const selected = source.trace.selected.find(
                  (page) => page.reference.objectId === entry.knowledgePageId
                );
                if (
                  !selected ||
                  (entry.notebookRevision !== undefined &&
                    selected.revision !== entry.notebookRevision) ||
                  selected.contentDigest !== entry.contentDigest
                )
                  throw new Error('Native Context reference proof is unavailable.');
              }
              const needsReview =
                !candidate.ok ||
                relevant.some(
                  (entry) =>
                    changedPages.has(entry.knowledgePageId) ||
                    !Object.hasOwn(currentFiles, `${entry.knowledgePageId}.md`)
                );
              record(traces, `context-package:${trace.turnId}`, needsReview, {
                turnId: trace.turnId,
                contextPackageDigest: trace.contextPackageDigest,
              });
            }
          } catch {
            unavailable(traces);
          }
        } catch {
          unavailable(maintenance);
          unavailable(traces);
        }
      }
    } catch {
      unavailable(maintenance);
      unavailable(traces);
    }
    for (const row of rows) {
      row.records.sort((a, b) => compareCodeUnits(a.id, b.id));
      if (row.complete && !hiddenAvailability.has(row.family))
        row.inventoryDigest = digest(facts.get(row.family));
    }
    return {
      rows,
      fingerprints: new Map(rows.map((row) => [row.family, digest(facts.get(row.family))])),
    };
  }

  const first = yield* inspect();
  const dependencyInventory = first.rows;
  const later = yield* inspect();
  for (const row of dependencyInventory) {
    const current = later.rows.find((entry) => entry.family === row.family)!;
    if (
      digest(row) !== digest(current) ||
      first.fingerprints.get(row.family) !== later.fingerprints.get(row.family)
    ) {
      row.complete = false;
      // Earlier disclosure admission may have been revoked; retain no stale first-scan details.
      row.records = [];
      delete row.inventoryDigest;
      row.diagnostics = [{ code: 'schema.inventory_changed' }];
    }
  }
  // Both drivers recheck current authority at the complete inspection return boundary.
  const revalidation = input.revalidate();
  if (revalidation) yield* revalidation;
  if (input.notebook.publishedRevision() !== revision) throw new NotebookError('conflict');
  return {
    ...notebook,
    coverage: 'workspace',
    completeMigration: false,
    inventoryComplete: dependencyInventory.every((row) => row.complete),
    dependencyInventory,
  };
}
