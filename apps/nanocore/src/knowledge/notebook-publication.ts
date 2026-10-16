import { isDeepStrictEqual } from 'node:util';
import {
  type ActorRef,
  type KnowledgeNotebookAdmission,
  KnowledgeNotebookAdmissionSchema,
} from '@openkit/protocol';
import { recordWorkspaceAuditEvent } from '../audit-events.js';
import type { FsStore } from '../lib/store.js';
import {
  commandInputHash,
  IdempotencyKeyConflictError,
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from '../runtime/idempotent-command.js';
import type { WorkspaceDb } from '../storage/db.js';
import { type KnowledgeNotebook, NotebookError } from './notebook.js';
import { validateNotebookCandidate } from './notebook-validation.js';
import { parseOkfDocument, updateOkfFrontmatter, validateOpenKitKnowledgeProfile } from './okf.js';

const OPERATION = 'knowledge.notebook.update';

/** Existing public commands share one content publisher and retain their own command identity. */
export type NotebookPublicationOperation =
  | typeof OPERATION
  | 'knowledge.notebook.restore'
  | 'knowledge.create'
  | 'knowledge.update'
  | 'knowledge.proposal.decide'
  | 'knowledge.proposal.reverse'
  | 'knowledge.delete';

/** Exact human edit submitted through native admission; paths are bundle-relative, never host paths. */
export interface NotebookUpdate {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly baseRevision: string;
  readonly changes: readonly { readonly path: string; readonly content: string | null }[];
  readonly summary: string;
}

/** Exact commit result reconstructed from immutable content and existing completion evidence. */
export interface NotebookPublication {
  readonly outcome: 'published';
  readonly ownerScope: { readonly kind: 'workspace'; readonly workspaceId: string };
  readonly baseRevision: string;
  readonly notebookRevision: string;
  readonly changedPageIds: readonly string[];
  readonly receiptRef: {
    readonly operation: NotebookPublicationOperation;
    readonly requestId: string;
    readonly ownerScope: NotebookPublication['ownerScope'];
  };
}

/** Current admission facts supplied only by the native scope/source/policy owners. */
export interface NotebookPublicationAdmission {
  readonly reviewRequiredPageIds: readonly string[];
  readonly scopeSchemaText: string;
  readonly registeredSources: ReadonlyMap<string, string | null>;
  readonly resolvedReferences: ReadonlyMap<string, ReadonlySet<string>>;
}

/** Native dependencies; revalidation must throw on revoked scope, source disclosure or required human authority. */
export interface NotebookPublicationDependencies {
  /** Server-bound original command input; native convenience projections must not create a nested receipt. */
  readonly command?: { readonly name: NotebookPublicationOperation; readonly input: unknown };
  readonly store: FsStore;
  readonly workspaceDb: WorkspaceDb;
  readonly notebook: KnowledgeNotebook;
  readonly producer: ActorRef;
  /** Actual current human command actor, separate from the immutable candidate producer. */
  readonly actor?: Extract<ActorRef, { kind: 'user' }>;
  /** Exact existing Proposal candidate; the callback appends its human Review before publication. */
  readonly reviewedCandidate?: {
    readonly proposalId: string;
    readonly candidateRevision: string;
    readonly recordDecision: () => void;
  };
  /** Human-confirmed removed paths and their exact bytes at the fixed base. */
  readonly confirmedRemovals?: Readonly<Record<string, string>>;
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  readonly revalidate: () => NotebookPublicationAdmission;
}

/** A direct human edit cannot inherit or invent a content-bound human Review label. */
export function humanPageBytes(path: string, content: string, workspaceId: string): string {
  const parsed = parseOkfDocument({ path, content });
  if (!parsed.ok) throw new NotebookError('invalid_request');
  if (parsed.document.reserved) return content;
  const profile = validateOpenKitKnowledgeProfile(parsed.document, {
    kind: 'workspace',
    workspaceId,
  });
  if (profile.conformance !== 'OpenKit-profile-valid') throw new NotebookError('invalid_request');
  return parsed.document.frontmatter.review_state === 'user-authored'
    ? content
    : updateOkfFrontmatter({ path, content, updates: { review_state: 'user-authored' } });
}

/** Reads only this command's existing Audit evidence; page content is never stored in Audit. */
export function readWorkspaceNotebookAdmissions(
  dependencies: Pick<
    NotebookPublicationDependencies,
    'workspaceDb' | 'producer' | 'command' | 'reviewedCandidate'
  >,
  request: Pick<NotebookUpdate, 'workspaceId' | 'requestId'>,
  action: string
): KnowledgeNotebookAdmission[] {
  const rows = dependencies.workspaceDb.sqlite
    .prepare(
      'SELECT notebook_admission_json AS admission FROM audit_events WHERE workspace_id = ? AND request_id = ? AND action = ? AND outcome = ?'
    )
    .all(request.workspaceId, request.requestId, action, 'succeeded') as {
    admission: string | null;
  }[];
  return rows
    .map(({ admission }) => {
      try {
        const parsed = KnowledgeNotebookAdmissionSchema.parse(JSON.parse(admission ?? 'null'));
        if (
          parsed.ownerScope.kind !== 'workspace' ||
          parsed.ownerScope.workspaceId !== request.workspaceId ||
          parsed.requestId !== request.requestId
        )
          throw new NotebookError('recovery_required');
        return parsed;
      } catch {
        throw new NotebookError('recovery_required');
      }
    })
    .filter(
      (admission) =>
        isDeepStrictEqual(admission.producer, dependencies.producer) &&
        (dependencies.reviewedCandidate
          ? admission.authority.kind === 'proposal' &&
            admission.authority.proposalId === dependencies.reviewedCandidate.proposalId
          : admission.authority.kind === 'direct' &&
            admission.authority.instructionReference ===
              `${dependencies.command?.name ?? OPERATION}:${request.requestId}`)
    );
}

/** Verifies an existing admission against its exact immutable candidate before replay or explicit retry. */
export function readWorkspaceNotebookAdmissionRevision(
  dependencies: Pick<
    NotebookPublicationDependencies,
    'notebook' | 'producer' | 'command' | 'reviewedCandidate'
  >,
  request: NotebookUpdate,
  evidence: KnowledgeNotebookAdmission
) {
  const candidate = dependencies.notebook.readRevision(evidence.candidateRevision);
  const inputDigest = commandInputHash(dependencies.command?.input ?? request);
  if (
    evidence.ownerScope.kind !== 'workspace' ||
    evidence.ownerScope.workspaceId !== request.workspaceId ||
    evidence.requestId !== request.requestId ||
    evidence.inputDigest !== inputDigest ||
    candidate.parentRevision !== request.baseRevision ||
    (!dependencies.reviewedCandidate &&
      (candidate.metadata.changeRequest.requestId !== request.requestId ||
        candidate.metadata.changeRequest.inputDigest !== inputDigest)) ||
    candidate.metadata.summary !== request.summary ||
    !isDeepStrictEqual(candidate.metadata.producer, dependencies.producer) ||
    !isDeepStrictEqual(evidence.producer, dependencies.producer) ||
    evidence.baseRevision !== candidate.parentRevision ||
    !isDeepStrictEqual(evidence.authority, candidate.metadata.authority) ||
    !isDeepStrictEqual(evidence.sourceReferences, candidate.metadata.sourceReferences) ||
    (dependencies.reviewedCandidate
      ? candidate.revision !== dependencies.reviewedCandidate.candidateRevision ||
        candidate.metadata.authority.kind !== 'proposal' ||
        candidate.metadata.authority.proposalId !== dependencies.reviewedCandidate.proposalId
      : candidate.metadata.authority.kind !== 'direct' ||
        candidate.metadata.authority.instructionReference !==
          `${dependencies.command?.name ?? OPERATION}:${request.requestId}`)
  )
    throw new NotebookError('recovery_required');
  return candidate;
}

/** Publishes a human Workspace edit through one Git CAS, with existing Audit and receipt owners. */
export async function publishWorkspaceNotebook(
  dependencies: NotebookPublicationDependencies,
  request: NotebookUpdate
): Promise<NotebookPublication> {
  if (dependencies.workspaceDb.workspaceId !== request.workspaceId)
    throw new NotebookError('recovery_required');
  const ownerScope = { kind: 'workspace', workspaceId: request.workspaceId } as const;
  const operation = dependencies.command?.name ?? OPERATION;
  const commandInput = dependencies.command?.input ?? request;
  const inputDigest = commandInputHash(commandInput);
  const actor =
    dependencies.actor ?? (dependencies.producer.kind === 'user' ? dependencies.producer : null);
  if (!actor) throw new NotebookError('invalid_request');
  const scope = { workspaceId: request.workspaceId, actorId: actor.id };
  dependencies.revalidate();

  const project = (revision: string, evidence: KnowledgeNotebookAdmission): NotebookPublication => {
    if (revision !== evidence.candidateRevision) throw new NotebookError('recovery_required');
    const candidate = readWorkspaceNotebookAdmissionRevision(dependencies, request, evidence);
    // A saved unpublished candidate is not a completed publication.
    dependencies.notebook.history({ revision, limit: 1 });
    const base = dependencies.notebook.readRevision(request.baseRevision);
    const expected = { ...base.files };
    for (const { path, content } of request.changes) {
      if (content === null) delete expected[path];
      else
        expected[path] =
          dependencies.reviewedCandidate || base.files[path] === content
            ? content
            : humanPageBytes(path, content, request.workspaceId);
    }
    if (
      Object.keys(expected).length !== Object.keys(candidate.files).length ||
      Object.entries(expected).some(([path, content]) => candidate.files[path] !== content)
    )
      throw new NotebookError('recovery_required');
    const changedPageIds = [
      ...new Set([...Object.keys(base.files), ...Object.keys(candidate.files)]),
    ]
      .filter((path) => base.files[path] !== candidate.files[path])
      .map((path) => path.slice(0, -3))
      .sort();
    return {
      outcome: 'published',
      ownerScope,
      baseRevision: request.baseRevision,
      notebookRevision: revision,
      changedPageIds,
      receiptRef: { operation, requestId: request.requestId, ownerScope },
    };
  };

  return runIdempotentCommand({
    store: dependencies.store,
    workspaceDb: dependencies.workspaceDb,
    inflightCommands: dependencies.inflightCommands,
    command: operation,
    requestId: request.requestId,
    scope,
    input: commandInput,
    responseKind: 'knowledge_notebook_revision',
    responseId: (result) => result.notebookRevision,
    replay: (receipt) => {
      dependencies.revalidate();
      const admitted = readWorkspaceNotebookAdmissions(
        dependencies,
        request,
        'knowledge.notebook.admit'
      ).find((event) => event.candidateRevision === receipt.response.id);
      const completed = readWorkspaceNotebookAdmissions(dependencies, request, operation).find(
        (event) => event.candidateRevision === receipt.response.id
      );
      if (
        !admitted ||
        !isDeepStrictEqual(admitted, completed) ||
        admitted.inputDigest !== inputDigest ||
        !isDeepStrictEqual(admitted.ownerScope, ownerScope)
      )
        throw new NotebookError('recovery_required');
      return project(receipt.response.id, admitted);
    },
    execute: () => {
      for (const prior of readWorkspaceNotebookAdmissions(
        dependencies,
        request,
        'knowledge.notebook.admit'
      )) {
        if (prior.inputDigest !== inputDigest) throw new IdempotencyKeyConflictError();
        readWorkspaceNotebookAdmissionRevision(dependencies, request, prior);
        let published = false;
        try {
          dependencies.notebook.history({ revision: prior.candidateRevision, limit: 1 });
          published = true;
        } catch (error) {
          if (!(error instanceof NotebookError) || error.code !== 'invalid_request') throw error;
        }
        if (published) throw new NotebookError('recovery_required');
      }
      const current = dependencies.notebook.publishedRevision();
      if (current !== request.baseRevision) throw new NotebookError('conflict', current);
      if (
        request.changes.length > 256 ||
        new Set(request.changes.map((change) => change.path)).size !== request.changes.length
      )
        throw new NotebookError('invalid_request');
      const base = dependencies.notebook.readRevision(request.baseRevision);
      const files = { ...base.files };
      for (const { path, content } of request.changes) {
        if (content === null) delete files[path];
        else
          files[path] =
            dependencies.reviewedCandidate || base.files[path] === content
              ? content
              : humanPageBytes(path, content, request.workspaceId);
      }
      const check = (facts: NotebookPublicationAdmission) =>
        validateNotebookCandidate({ ownerScope, base, candidate: { files }, ...facts });
      const admission = dependencies.revalidate();
      const validated = check(admission);
      if (validated.errors.length) throw new NotebookError('invalid_request');
      if (
        !dependencies.reviewedCandidate &&
        validated.changedPaths.some((path) =>
          admission.reviewRequiredPageIds.includes(path.slice(0, -3))
        )
      )
        throw new NotebookError('review_required');
      if (
        validated.removedPaths.some(
          (path) => dependencies.confirmedRemovals?.[path] !== base.files[path]
        )
      )
        throw new NotebookError('invalid_request');
      const authority = dependencies.reviewedCandidate
        ? { kind: 'proposal' as const, proposalId: dependencies.reviewedCandidate.proposalId }
        : ({
            kind: 'direct',
            instructionReference: `${operation}:${request.requestId}`,
          } as const);
      const candidateRevision =
        dependencies.reviewedCandidate?.candidateRevision ??
        dependencies.notebook.prepare({
          baseRevision: request.baseRevision,
          changes: Object.fromEntries(
            request.changes.map(({ path, content }) => [
              path,
              content === null ? null : files[path]!,
            ])
          ),
          metadata: {
            summary: request.summary,
            changeRequest: { requestId: request.requestId, inputDigest },
            producer: dependencies.producer,
            authority,
            sourceReferences: [...validated.sourceReferences],
          },
        });
      // All work from this final current-authority check through CAS is synchronous, with no model run or await.
      const finalAdmission = dependencies.revalidate();
      const finalValidation = check(finalAdmission);
      if (
        !dependencies.reviewedCandidate &&
        validated.changedPaths.some((path) =>
          finalAdmission.reviewRequiredPageIds.includes(path.slice(0, -3))
        )
      )
        throw new NotebookError('review_required');
      if (
        finalValidation.errors.length ||
        !isDeepStrictEqual(finalValidation.sourceReferences, validated.sourceReferences)
      )
        throw new NotebookError('invalid_request');
      const evidence: KnowledgeNotebookAdmission = {
        ownerScope,
        requestId: request.requestId,
        inputDigest,
        baseRevision: request.baseRevision,
        candidateRevision,
        producer: dependencies.producer,
        authority,
        sourceReferences: [...validated.sourceReferences],
      };
      const audit = (action: string) =>
        recordWorkspaceAuditEvent({
          workspaceDb: dependencies.workspaceDb,
          workspaceId: request.workspaceId,
          requestId: request.requestId,
          actor,
          category: 'knowledge',
          action,
          outcome: 'succeeded',
          resource: `knowledge-notebook:${candidateRevision}`,
          notebookAdmission: evidence,
          summary: 'Notebook publication evidence retained.',
        });
      if (dependencies.reviewedCandidate) {
        const retained = dependencies.notebook.retainedCandidate(
          dependencies.reviewedCandidate.proposalId
        );
        if (
          retained.revision !== candidateRevision ||
          retained.parentRevision !== request.baseRevision
        )
          throw new NotebookError('conflict');
        // Verify the retained candidate before recording its human decision or advancing the ref.
        readWorkspaceNotebookAdmissionRevision(dependencies, request, evidence);
        const retainedFiles = dependencies.notebook.readRevision(candidateRevision).files;
        if (
          Object.keys(retainedFiles).length !== Object.keys(files).length ||
          Object.entries(files).some(([path, bytes]) => retainedFiles[path] !== bytes)
        )
          throw new NotebookError('conflict');
        dependencies.reviewedCandidate.recordDecision();
      }
      audit('knowledge.notebook.admit');
      dependencies.notebook.publish({ baseRevision: request.baseRevision, candidateRevision });
      audit(operation);
      return project(candidateRevision, evidence);
    },
  });
}
