import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  ArtifactReviewRangeFeedback,
  BindThreadMaterialRequest,
  BindThreadMaterialResponse,
  CreateWorkspaceMaterialRequest,
  CreateWorkspaceMaterialResponse,
  ExcludeThreadMaterialRequest,
  ExcludeThreadMaterialResponse,
  RestoreThreadMaterialRequest,
  RestoreThreadMaterialResponse,
  SaveWorkspaceMaterialRevisionRequest,
  SaveWorkspaceMaterialRevisionResponse,
  ThreadMaterialView,
  UnbindThreadMaterialRequest,
  UnbindThreadMaterialResponse,
  WorkspaceMaterialRevisionSummary,
  WorkspaceMaterialRevisionView,
  WorkspaceMaterialView,
} from '@openkit/app-api-schemas';
import {
  BindThreadMaterialRequestSchema,
  BindThreadMaterialResponseSchema,
  CorrectMaterialRangeRequestSchema,
  CreateWorkspaceMaterialRequestSchema,
  CreateWorkspaceMaterialResponseSchema,
  ExcludeThreadMaterialRequestSchema,
  ExcludeThreadMaterialResponseSchema,
  JudgementRecordReaderSchema,
  JudgementRecordSchema,
  RestoreThreadMaterialRequestSchema,
  RestoreThreadMaterialResponseSchema,
  SaveWorkspaceMaterialRevisionRequestSchema,
  SaveWorkspaceMaterialRevisionResponseSchema,
  UnbindThreadMaterialRequestSchema,
  UnbindThreadMaterialResponseSchema,
} from '@openkit/app-api-schemas';
import {
  type ActorRef,
  ActorRefSchema,
  deriveEntityId,
  MaterialIdSchema,
  MaterialRevisionIdSchema,
  responsibleUserIdForActor,
  ThreadIdSchema,
  UserActorRefSchema,
} from '@openkit/protocol';
import { z } from 'zod';

import { commandRequestKey } from './lib/store.js';
import {
  appendMaterialJudgement,
  correctMaterialRange,
  readMaterialJudgement,
} from './material-range-corrections.js';
import { OperationError } from './operation-error.js';
import { commandInputHash, IdempotencyKeyConflictError } from './runtime/idempotent-command.js';
import {
  getCommandRequestRecordFromDb,
  recordControlCommandRequestRecordInDb,
} from './storage/command-request-records.js';
import { assertControlProductWriter, readProduct } from './storage/control-store-products.js';
import { getControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import type { WorkspaceDb } from './storage/db.js';
import { nativeProductScope } from './storage/workspace-file-records.js';

/** Closed Material failure codes owned by S16. */
type WorkspaceMaterialErrorCode =
  | 'conflict'
  | 'recovery_required'
  | 'source_digest_mismatch'
  | 'stale';

/** Known Material refusals can cross the trusted native boundary without exposing SQL diagnostics. */
export class WorkspaceMaterialError extends Error {
  readonly status: 400 | 409;
  constructor(
    readonly code: WorkspaceMaterialErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'WorkspaceMaterialError';
    this.status = code === 'source_digest_mismatch' ? 400 : 409;
  }
}

/** Material authority row with private request proof. */
type MaterialRow = WorkspaceMaterialView & { readonly lastMutationRequestId: string };

/** Immutable revision authority row with private request proof. */
type RevisionRow = Omit<WorkspaceMaterialRevisionView, 'judgements'> & {
  readonly createdByRequestId: string;
  readonly judgementsJson: string;
};

/**
 * Verifies a UTF-16 range against the exact immutable Material source.
 * @param workspaceDb Database that owns the original revision.
 * @param range Exact source identity, digest, offsets and original text.
 * @returns The verified original revision without normalization.
 * @throws A stale or recovery error when the source cannot support the range.
 */
export function assertWorkspaceMaterialRange(
  workspaceDb: WorkspaceDb,
  range: ArtifactReviewRangeFeedback
): WorkspaceMaterialRevisionView {
  const revision = getWorkspaceMaterialRevision(workspaceDb, range.materialId, range.revisionId);
  const content = revision.content;
  /** Source offsets count UTF-16 units and must not separate a surrogate pair. */
  const splitsPair = (offset: number) =>
    offset > 0 &&
    offset < content.length &&
    content.charCodeAt(offset - 1) >= 0xd800 &&
    content.charCodeAt(offset - 1) <= 0xdbff &&
    content.charCodeAt(offset) >= 0xdc00 &&
    content.charCodeAt(offset) <= 0xdfff;
  if (
    revision.contentDigest !== range.contentDigest ||
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    range.start < 0 ||
    range.start >= range.end ||
    range.end > content.length ||
    splitsPair(range.start) ||
    splitsPair(range.end) ||
    content.slice(range.start, range.end) !== range.originalText
  ) {
    throw materialError('stale', 'The range does not match the exact original Material source.');
  }
  return revision;
}

/** Portable revision retains its raw descriptive annotations without exposing their SQLite encoding. */
type ExportableRevisionRow = Omit<RevisionRow, 'judgementsJson'> & {
  readonly judgements: WorkspaceMaterialRevisionView['judgements'];
};

/** Thread binding authority row. */
type BindingRow = {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly materialId: string;
  readonly bindingState: 'bound' | 'unbound';
  readonly latestQueuedRevisionId: string | null;
  readonly inclusionState: 'included' | 'excluded';
  readonly lastMutationRequestId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/** Exact bound queue candidate supplied to the S39 Context Package owner. */
export interface QueuedThreadMaterialSelection {
  /** Material identity selected from the Thread binding. */
  readonly materialId: string;
  /** Exact immutable revision identity. */
  readonly revisionId: string;
  /** Previous immutable revision, or null for the root revision. */
  readonly parentRevisionId: string | null;
  /** Media type derived from the Material kind. */
  readonly mediaType: 'text/markdown' | 'text/plain';
  /** Digest of the exact canonical UTF-8 content. */
  readonly contentDigest: string;
  /** Exact canonical UTF-8 content. */
  readonly content: string;
  /** Immutable Material sensitivity. */
  readonly sensitivity: 'public' | 'internal' | 'restricted';
  /** Whether S39 may include the queued revision automatically. */
  readonly inclusionState: 'included' | 'excluded';
  /** S39 inclusion reason for this binding-owned candidate. */
  readonly inclusionReason: 'thread_binding';
  /** Exact binding mutation proof frozen with the selected queue. */
  readonly bindingMutationRequestId: string;
}

/** Adds the accepted timestamp to one parsed command. */
type AcceptedCommand<T> = T & { readonly acceptedAt: string };

/** Adds one Material and Thread owner scope to a parsed command. */
type BindingCommand<T> = AcceptedCommand<T> & {
  readonly materialId: string;
  readonly threadId: string;
};

/** Accepted create command with authenticated scope. */
export type CreateWorkspaceMaterialInput = AcceptedCommand<CreateWorkspaceMaterialRequest> & {
  readonly actor: ActorRef;
};

/** Accepted save command with authenticated scope. */
export type SaveWorkspaceMaterialRevisionInput =
  AcceptedCommand<SaveWorkspaceMaterialRevisionRequest> & {
    readonly actor: ActorRef;
    readonly materialId: string;
  };

/** Accepted bind command with its composite owner identity. */
export type BindThreadMaterialInput = BindingCommand<BindThreadMaterialRequest>;

/** Accepted unbind command with its composite owner identity. */
export type UnbindThreadMaterialInput = BindingCommand<UnbindThreadMaterialRequest>;

/** Accepted exclusion command with its composite owner identity. */
export type ExcludeThreadMaterialInput = BindingCommand<ExcludeThreadMaterialRequest>;

/** Accepted restore command with its composite owner identity. */
export type RestoreThreadMaterialInput = BindingCommand<RestoreThreadMaterialRequest>;

/** Original command identity and fingerprint; the result pointer is decided on the native handle. */
const MaterialReceiptSchema = z
  .object({
    key: z.string().min(1),
    command: z.enum([
      'material.create',
      'material.save',
      'material.bind',
      'material.unbind',
      'material.exclude',
      'material.restore',
      'material.range-correct',
      'evaluation.judgement-add',
    ]),
    requestId: z.string().min(1),
    scope: z.record(z.string(), z.string()),
    inputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    responseKind: z.enum([
      'material',
      'material_revision',
      'thread_material_binding',
      'evaluation_judgement',
    ]),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();
/** Accepted time belongs to the admitted command, never to public caller metadata. */
const acceptedFields = { acceptedAt: z.string().datetime() };
/** Each binding mutation names its exact composite owner. */
const bindingFields = { ...acceptedFields, materialId: MaterialIdSchema, threadId: ThreadIdSchema };
/** Human exact-range assessment excludes selection and the separate content-correction command. */
const materialRangeJudgement = JudgementRecordSchema.refine(
  (value) =>
    value.target.kind === 'material-range' && ['accept', 'reject', 'rate'].includes(value.kind)
);

/** Closed Material-family programs; queue consumption has verified binding proof and no manufactured receipt. */
export const ControlMaterialCommandInputSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('create'),
      input: CreateWorkspaceMaterialRequestSchema.extend({
        ...acceptedFields,
        actor: ActorRefSchema,
      }),
      receipt: MaterialReceiptSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal('save'),
      input: SaveWorkspaceMaterialRevisionRequestSchema.extend({
        ...acceptedFields,
        actor: ActorRefSchema,
        materialId: MaterialIdSchema,
      }),
      receipt: MaterialReceiptSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal('bind'),
      input: BindThreadMaterialRequestSchema.extend(bindingFields),
      receipt: MaterialReceiptSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal('unbind'),
      input: UnbindThreadMaterialRequestSchema.extend(bindingFields),
      receipt: MaterialReceiptSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal('exclude'),
      input: ExcludeThreadMaterialRequestSchema.extend(bindingFields),
      receipt: MaterialReceiptSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal('restore'),
      input: RestoreThreadMaterialRequestSchema.extend(bindingFields),
      receipt: MaterialReceiptSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal('range-judgement'),
      input: materialRangeJudgement,
      receipt: MaterialReceiptSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal('range-correct'),
      input: CorrectMaterialRangeRequestSchema.extend({
        ...acceptedFields,
        actor: UserActorRefSchema,
      }),
      receipt: MaterialReceiptSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal('consume'),
      input: z
        .object({
          threadId: ThreadIdSchema,
          materialId: MaterialIdSchema,
          revisionId: MaterialRevisionIdSchema,
          bindingMutationRequestId: z.string().min(1),
        })
        .strict(),
    })
    .strict(),
]);
/** Structured-clone inputs for this single family's existing deciding bodies. */
export type ControlMaterialCommandInput = z.infer<typeof ControlMaterialCommandInputSchema>;

/** Fully materialized results checked before the worker commits and again before resolving a caller. */
export const ControlMaterialCommandResultSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('create'),
    value: CreateWorkspaceMaterialResponseSchema,
    replayed: z.boolean(),
  }),
  z.object({
    mode: z.literal('save'),
    value: SaveWorkspaceMaterialRevisionResponseSchema,
    replayed: z.boolean(),
  }),
  z.object({
    mode: z.literal('bind'),
    value: BindThreadMaterialResponseSchema,
    replayed: z.boolean(),
  }),
  z.object({
    mode: z.literal('unbind'),
    value: UnbindThreadMaterialResponseSchema,
    replayed: z.boolean(),
  }),
  z.object({
    mode: z.literal('exclude'),
    value: ExcludeThreadMaterialResponseSchema,
    replayed: z.boolean(),
  }),
  z.object({
    mode: z.literal('restore'),
    value: RestoreThreadMaterialResponseSchema,
    replayed: z.boolean(),
  }),
  z.object({
    mode: z.literal('range-judgement'),
    value: z.object({ judgement: JudgementRecordSchema }),
    replayed: z.boolean(),
  }),
  z.object({
    mode: z.literal('range-correct'),
    value: z.object({ judgement: JudgementRecordSchema }),
    replayed: z.boolean(),
  }),
  z.object({
    mode: z.literal('consume'),
    value: z.object({ outcome: z.enum(['consumed', 'superseded']) }),
    replayed: z.boolean(),
  }),
]);
/** Result tied to the admitted mode, never a generic Work Resource record. */
export type ControlMaterialCommandResult = z.infer<typeof ControlMaterialCommandResultSchema>;

/** Opens the existing native Workspace writer and waits for the complete Material tuple and original receipt. */
export async function executeControlMaterialCommand<T extends ControlMaterialCommandInput>(
  db: WorkspaceDb,
  input: T
): Promise<Extract<ControlMaterialCommandResult, { mode: T['mode'] }>> {
  const scope = nativeProductScope(db.dataRoot, { kind: 'workspace', workspaceId: db.workspaceId });
  const database = `workspace:${scope.path}`;
  const client = getControlStoreWorkerClient();
  await client.open({
    database,
    path: scope.path,
    dataRoot: db.dataRoot,
    create: false,
    initialize: 'workspace',
    productOwner: scope.owner,
    contentMount: scope.contentMount,
  });
  const result = await client.material(database, input);
  if (result.mode !== input.mode)
    throw new OperationError(
      'recovery_required',
      'The Material acknowledgement has a different command mode.',
      409
    );
  return result as Extract<ControlMaterialCommandResult, { mode: T['mode'] }>;
}

/** Applies a complete Material command and its receipt on the worker's existing savepoint and handle. No callback, file effect or await occurs here. */
export function applyControlMaterialCommand(
  db: WorkspaceDb,
  value: ControlMaterialCommandInput
): ControlMaterialCommandResult {
  assertControlProductWriter(db.sqlite);
  const command = ControlMaterialCommandInputSchema.parse(value);
  const owner = { kind: 'workspace' as const, workspaceId: db.workspaceId };
  const requireThread = (threadId: string) => {
    if (!readProduct(db.sqlite, owner, 'thread', threadId))
      throw materialError('stale', 'The requested Thread does not exist.');
  };
  if (command.mode === 'consume') {
    requireThread(command.input.threadId);
    const input = command.input;
    return {
      mode: 'consume',
      value: {
        outcome: consumeQueuedThreadMaterialRevision(
          db,
          input.threadId,
          input.materialId,
          input.revisionId,
          input.bindingMutationRequestId
        ),
      },
      replayed: false,
    };
  }
  const receipt = command.receipt;
  const input = command.input;
  let expectedCommand: typeof receipt.command;
  let expectedKind: typeof receipt.responseKind;
  let expectedScope: Record<string, string> = { workspaceId: db.workspaceId };
  let expectedInput: unknown;
  switch (command.mode) {
    case 'create':
      expectedCommand = 'material.create';
      expectedKind = 'material';
      expectedInput = {
        title: command.input.title,
        kind: command.input.kind,
        sensitivity: command.input.sensitivity,
      };
      break;
    case 'save':
      expectedCommand = 'material.save';
      expectedKind = 'material_revision';
      expectedScope = { ...expectedScope, materialId: command.input.materialId };
      expectedInput = {
        expectedRevisionId: command.input.expectedRevisionId,
        contentDigest: command.input.contentDigest,
      };
      break;
    case 'bind':
    case 'unbind':
    case 'exclude':
    case 'restore': {
      expectedCommand = `material.${command.mode}`;
      expectedKind = 'thread_material_binding';
      const { materialId, threadId, acceptedAt: _, requestId: __, ...expected } = command.input;
      expectedScope = { ...expectedScope, threadId, materialId };
      expectedInput = expected;
      break;
    }
    case 'range-judgement': {
      expectedCommand = 'evaluation.judgement-add';
      expectedKind = 'evaluation_judgement';
      const { kind, target, choice, note, extensions, actor } = command.input;
      expectedInput = { actor, judgement: { kind, target, choice, note, extensions } };
      break;
    }
    case 'range-correct': {
      expectedCommand = 'material.range-correct';
      expectedKind = 'evaluation_judgement';
      const { acceptedAt: _, ...expected } = command.input;
      expectedInput = expected;
      break;
    }
  }
  if (
    receipt.command !== expectedCommand ||
    receipt.responseKind !== expectedKind ||
    receipt.requestId !== input.requestId ||
    !isDeepStrictEqual(receipt.scope, expectedScope) ||
    receipt.key !== commandRequestKey(receipt.command, receipt.requestId, receipt.scope) ||
    receipt.inputHash !== commandInputHash(expectedInput) ||
    receipt.expiresAt <= receipt.createdAt ||
    ('workspaceId' in input && input.workspaceId !== db.workspaceId)
  ) {
    throw new OperationError(
      'invalid_request',
      'The Material command receipt does not match its admitted input.',
      400
    );
  }
  if (
    command.mode === 'save' &&
    contentDigest(command.input.content) !== command.input.contentDigest
  )
    throw materialError('source_digest_mismatch', 'Material content does not match its digest.');
  const prior = getCommandRequestRecordFromDb(db, receipt.key, receipt.createdAt);
  if ('threadId' in command.input) {
    try {
      requireThread(command.input.threadId);
    } catch (error) {
      if (prior)
        throw materialError(
          'recovery_required',
          'The Material binding receipt has no matching Thread owner.'
        );
      throw error;
    }
  }
  if (prior) {
    if (
      prior.command !== receipt.command ||
      prior.requestId !== receipt.requestId ||
      commandRequestKey(prior.command, prior.requestId, prior.scope) !== receipt.key
    )
      throw materialError(
        'recovery_required',
        'The retained Material receipt identity is inconsistent.'
      );
    if (prior.inputHash !== receipt.inputHash) throw new IdempotencyKeyConflictError();
    if (prior.response.kind !== expectedKind)
      throw materialError(
        'recovery_required',
        'The Material receipt has invalid response lineage.'
      );
    switch (command.mode) {
      case 'create':
        try {
          getWorkspaceMaterial(db, prior.response.id);
        } catch {
          throw materialError(
            'recovery_required',
            'The Material create receipt has no matching owner.'
          );
        }
        return { mode: command.mode, value: { materialId: prior.response.id }, replayed: true };
      case 'save': {
        const revision = findRevision(db, command.input.materialId, prior.response.id);
        if (revision?.createdByRequestId !== receipt.requestId)
          throw materialError(
            'recovery_required',
            'The Material save receipt has no matching revision owner.'
          );
        try {
          getWorkspaceMaterialRevision(db, command.input.materialId, prior.response.id);
        } catch {
          throw materialError(
            'recovery_required',
            'The Material save receipt has no matching revision owner.'
          );
        }
        return {
          mode: command.mode,
          value: { materialId: command.input.materialId, revisionId: prior.response.id },
          replayed: true,
        };
      }
      case 'bind':
      case 'unbind':
      case 'exclude':
      case 'restore': {
        const input = command.input;
        if (
          prior.response.id !== input.materialId ||
          !findBinding(db, input.threadId, input.materialId)
        )
          throw materialError(
            'recovery_required',
            'The Material binding receipt has no matching owner.'
          );
        try {
          getWorkspaceMaterial(db, input.materialId);
        } catch {
          throw materialError(
            'recovery_required',
            'The Material binding receipt has no matching Material owner.'
          );
        }
        const outcome =
          command.mode === 'bind'
            ? 'bound'
            : command.mode === 'unbind'
              ? 'unbound'
              : command.mode === 'exclude'
                ? 'excluded'
                : 'included';
        return ControlMaterialCommandResultSchema.parse({
          mode: command.mode,
          value: { materialId: input.materialId, threadId: input.threadId, outcome },
          replayed: true,
        });
      }
      case 'range-judgement':
      case 'range-correct': {
        if (command.input.target.kind !== 'material-range')
          throw new OperationError(
            'invalid_request',
            'The judgement must target an exact Material range.',
            400
          );
        const judgement = readMaterialJudgement(db, command.input.target, receipt.requestId);
        if (!judgement || prior.response.id !== receipt.requestId)
          throw materialError(
            'recovery_required',
            'The Material receipt has no matching judgement owner.'
          );
        if (command.mode === 'range-judgement') {
          for (const key of [
            'kind',
            'target',
            'choice',
            'note',
            'extensions',
            'actor',
            'workspaceId',
            'requestId',
          ] as const)
            if (!isDeepStrictEqual(judgement[key], command.input[key]))
              throw materialError(
                'recovery_required',
                'The retained Material judgement differs from its request.'
              );
        } else if (
          judgement.kind !== 'correct' ||
          judgement.choice.outcome !== command.input.decision ||
          judgement.choice.replacementText !== command.input.replacementText ||
          !isDeepStrictEqual(judgement.actor, command.input.actor) ||
          judgement.note !== command.input.note ||
          !isDeepStrictEqual(judgement.extensions, command.input.extensions)
        )
          throw materialError(
            'recovery_required',
            'The retained Material correction differs from its request.'
          );
        return { mode: command.mode, value: { judgement }, replayed: true };
      }
    }
  }
  let result: ControlMaterialCommandResult;
  switch (command.mode) {
    case 'create':
      result = {
        mode: command.mode,
        value: createWorkspaceMaterial(db, command.input),
        replayed: false,
      };
      break;
    case 'save':
      result = {
        mode: command.mode,
        value: saveWorkspaceMaterialRevision(db, command.input),
        replayed: false,
      };
      break;
    case 'bind':
      result = {
        mode: command.mode,
        value: bindThreadMaterial(db, command.input),
        replayed: false,
      };
      break;
    case 'unbind':
      result = {
        mode: command.mode,
        value: unbindThreadMaterial(db, command.input),
        replayed: false,
      };
      break;
    case 'exclude':
      result = {
        mode: command.mode,
        value: excludeThreadMaterial(db, command.input),
        replayed: false,
      };
      break;
    case 'restore':
      result = {
        mode: command.mode,
        value: restoreThreadMaterial(db, command.input),
        replayed: false,
      };
      break;
    case 'range-judgement':
      result = {
        mode: command.mode,
        value: { judgement: appendMaterialJudgement(db, command.input) },
        replayed: false,
      };
      break;
    case 'range-correct':
      result = {
        mode: command.mode,
        value: { judgement: correctMaterialRange(db, command.input) },
        replayed: false,
      };
      break;
  }
  const responseId =
    command.mode === 'save'
      ? (result.value as SaveWorkspaceMaterialRevisionResponse).revisionId
      : command.mode === 'range-judgement' || command.mode === 'range-correct'
        ? receipt.requestId
        : (result.value as CreateWorkspaceMaterialResponse).materialId;
  const { responseKind: _, ...originalReceipt } = receipt;
  recordControlCommandRequestRecordInDb(db, {
    ...originalReceipt,
    response: { kind: expectedKind, id: responseId },
  });
  return result;
}

const MATERIAL_SELECT = `SELECT
  workspace_id AS workspaceId, material_id AS materialId, title, kind,
  current_revision_id AS currentRevisionId, sensitivity,
  last_mutation_request_id AS lastMutationRequestId,
  created_at AS createdAt, updated_at AS updatedAt
FROM workspace_materials`;

const REVISION_SELECT = `SELECT
  workspace_id AS workspaceId, material_id AS materialId, revision_id AS revisionId,
  parent_revision_id AS parentRevisionId, media_type AS mediaType,
  content_digest AS contentDigest, content, author_id AS authorId, judgements AS judgementsJson,
  created_by_request_id AS createdByRequestId, created_at AS createdAt
FROM workspace_material_revisions`;

const BINDING_SELECT = `SELECT
  workspace_id AS workspaceId, thread_id AS threadId, material_id AS materialId,
  binding_state AS bindingState, latest_queued_revision_id AS latestQueuedRevisionId,
  inclusion_state AS inclusionState, last_mutation_request_id AS lastMutationRequestId,
  created_at AS createdAt, updated_at AS updatedAt
FROM thread_material_bindings`;

/** Lists raw portable Material, revision, and binding owners in stable identity order. @param workspaceDb Workspace database. @returns Private export rows retaining request proof. */
export function listExportableWorkspaceMaterialRows(workspaceDb: WorkspaceDb): {
  readonly materials: readonly MaterialRow[];
  readonly revisions: readonly ExportableRevisionRow[];
  readonly bindings: readonly BindingRow[];
} {
  return {
    materials: workspaceDb.sqlite
      .prepare(`${MATERIAL_SELECT} WHERE workspace_id = ? ORDER BY material_id`)
      .all(workspaceDb.workspaceId) as MaterialRow[],
    revisions: (
      workspaceDb.sqlite
        .prepare(
          `${REVISION_SELECT} WHERE workspace_id = ? ORDER BY material_id, created_at, revision_id`
        )
        .all(workspaceDb.workspaceId) as RevisionRow[]
    ).map(({ judgementsJson, ...row }) => {
      const judgements: unknown = JSON.parse(judgementsJson);
      JudgementRecordReaderSchema.array().parse(judgements);
      return { ...row, judgements: judgements as WorkspaceMaterialRevisionView['judgements'] };
    }),
    bindings: workspaceDb.sqlite
      .prepare(`${BINDING_SELECT} WHERE workspace_id = ? ORDER BY thread_id, material_id`)
      .all(workspaceDb.workspaceId) as BindingRow[],
  };
}

/** Reads canonical sensitivity after Workspace admission without loading revision bytes. @param workspaceDb Authorized Workspace database. @param materialId Exact Material owner. @returns Stored sensitivity. @throws The owner's stale failure when metadata is absent. */
export function readWorkspaceMaterialSensitivity(
  workspaceDb: WorkspaceDb,
  materialId: string
): WorkspaceMaterialView['sensitivity'] {
  return requireMaterial(workspaceDb, materialId).sensitivity;
}

/** Lists Materials in stable order. @param workspaceDb Workspace database. @returns Closed views. @throws A recovery error for an invalid pointer. */
export function listWorkspaceMaterials(workspaceDb: WorkspaceDb): WorkspaceMaterialView[] {
  const rows = workspaceDb.sqlite
    .prepare(`${MATERIAL_SELECT} WHERE workspace_id = ? ORDER BY created_at, material_id`)
    .all(workspaceDb.workspaceId) as MaterialRow[];
  rows.forEach((row) => {
    assertMaterialPointer(workspaceDb, row);
  });
  return rows.map(toMaterialView);
}

/** Reads one Material. @param workspaceDb Workspace database. @param materialId Material id. @returns Closed view. @throws A stale or recovery error for absent or invalid authority. */
export function getWorkspaceMaterial(
  workspaceDb: WorkspaceDb,
  materialId: string
): WorkspaceMaterialView {
  const row = requireMaterial(workspaceDb, materialId);
  assertMaterialPointer(workspaceDb, row);
  return toMaterialView(row);
}

/** Lists immutable revisions in stable order. @param workspaceDb Workspace database. @param materialId Material id. @returns Closed summaries. @throws A stale or recovery error for absent or invalid authority. */
export function listWorkspaceMaterialRevisions(
  workspaceDb: WorkspaceDb,
  materialId: string
): WorkspaceMaterialRevisionSummary[] {
  requireMaterial(workspaceDb, materialId);
  const rows = workspaceDb.sqlite
    .prepare(
      `${REVISION_SELECT} WHERE workspace_id = ? AND material_id = ? ORDER BY created_at, revision_id`
    )
    .all(workspaceDb.workspaceId, materialId) as RevisionRow[];
  rows.forEach(assertRevisionContent);
  return rows.map(toRevisionSummary);
}

/** Reads an exact revision. @param workspaceDb Workspace database. @param materialId Material id. @param revisionId Revision id. @returns Closed content view. @throws A stale or recovery error for absent or invalid authority. */
export function getWorkspaceMaterialRevision(
  workspaceDb: WorkspaceDb,
  materialId: string,
  revisionId: string
): WorkspaceMaterialRevisionView {
  requireMaterial(workspaceDb, materialId);
  const row = findRevision(workspaceDb, materialId, revisionId);
  if (!row) {
    throw materialError('stale', 'The requested Material revision does not exist.');
  }
  assertRevisionContent(row);
  return toRevisionView(row);
}

/** Reads a Thread's singular Material. @param workspaceDb Workspace database. @param threadId Thread id. @returns Closed projection or null. @throws A recovery error for invalid binding lineage. */
export function getThreadMaterial(
  workspaceDb: WorkspaceDb,
  threadId: string
): ThreadMaterialView | null {
  const binding = workspaceDb.sqlite
    .prepare(
      `${BINDING_SELECT} WHERE workspace_id = ? AND thread_id = ? AND binding_state = 'bound'`
    )
    .get(workspaceDb.workspaceId, threadId) as BindingRow | undefined;
  if (!binding) {
    return null;
  }
  const material = findMaterial(workspaceDb, binding.materialId);
  if (!material) {
    throw materialError('recovery_required', 'The bound Material authority is missing.');
  }
  const currentRevision = material.currentRevisionId
    ? findRevision(workspaceDb, material.materialId, material.currentRevisionId)
    : undefined;
  if (material.currentRevisionId && !currentRevision) {
    throw materialError('recovery_required', 'The bound Material current revision is missing.');
  }
  if (currentRevision) {
    assertRevisionContent(currentRevision);
  }
  assertBindingQueue(workspaceDb, binding, material);
  return {
    workspaceId: workspaceDb.workspaceId,
    threadId,
    resource: toMaterialView(material),
    currentRevision: currentRevision ? toRevisionSummary(currentRevision) : null,
    inclusionState: binding.inclusionState,
    latestQueuedRevisionId: binding.latestQueuedRevisionId,
    lastWorkerSeenRevisionId: null,
    currentTurnRevisionId: null,
    activeDelivery: null,
  };
}

/**
 * Selects the exact queued revision from one bound Thread Material.
 *
 * @param workspaceDb Workspace database.
 * @param threadId Thread whose eligible queue should be read.
 * @returns Canonical S39 candidate, or null when no bound queue exists.
 * @throws A recovery error when the queued Material authority is missing or contradictory.
 */
export function selectQueuedThreadMaterialRevision(
  workspaceDb: WorkspaceDb,
  threadId: string
): QueuedThreadMaterialSelection | null {
  const binding = workspaceDb.sqlite
    .prepare(
      `${BINDING_SELECT} WHERE workspace_id = ? AND thread_id = ? AND binding_state = 'bound'`
    )
    .get(workspaceDb.workspaceId, threadId) as BindingRow | undefined;
  if (!binding || binding.latestQueuedRevisionId === null) {
    return null;
  }
  const material = findMaterial(workspaceDb, binding.materialId);
  if (!material) {
    throw materialError('recovery_required', 'The queued Material authority is missing.');
  }
  const revision = assertBindingQueue(workspaceDb, binding, material);
  if (!revision) {
    throw materialError('recovery_required', 'The queued Material revision is missing.');
  }
  const expectedMediaType = material.kind === 'markdown' ? 'text/markdown' : 'text/plain';
  if (revision.mediaType !== expectedMediaType) {
    throw materialError('recovery_required', 'The queued Material media type is invalid.');
  }
  if (
    revision.parentRevisionId &&
    (revision.parentRevisionId === revision.revisionId ||
      !findRevision(workspaceDb, material.materialId, revision.parentRevisionId))
  ) {
    throw materialError('recovery_required', 'The queued Material parent revision is invalid.');
  }
  return {
    materialId: material.materialId,
    revisionId: revision.revisionId,
    parentRevisionId: revision.parentRevisionId,
    mediaType: revision.mediaType,
    contentDigest: revision.contentDigest,
    content: revision.content,
    sensitivity: material.sensitivity,
    inclusionState: binding.inclusionState,
    inclusionReason: 'thread_binding',
    bindingMutationRequestId: binding.lastMutationRequestId,
  };
}

/**
 * Clears one post-verification queue only when its revision and mutation proof still match.
 *
 * @param workspaceDb Workspace database.
 * @param threadId Thread that owned the verified selection.
 * @param materialId Material named by the verified selection.
 * @param revisionId Revision named by the verified selection.
 * @param bindingMutationRequestId Binding proof named by the verified selection.
 * @returns `consumed` for an exact or already-cleared queue, otherwise `superseded` for later intent.
 * @throws A recovery error when the named binding is missing or contradicts the same proof.
 */
export function consumeQueuedThreadMaterialRevision(
  workspaceDb: WorkspaceDb,
  threadId: string,
  materialId: string,
  revisionId: string,
  bindingMutationRequestId: string
): 'consumed' | 'superseded' {
  return workspaceDb.sqlite.transaction(() => {
    const consumed = workspaceDb.sqlite
      .prepare(`UPDATE thread_material_bindings
        SET latest_queued_revision_id = NULL
        WHERE workspace_id = ? AND thread_id = ? AND material_id = ?
          AND binding_state = 'bound' AND inclusion_state = 'included'
          AND latest_queued_revision_id = ? AND last_mutation_request_id = ?`)
      .run(workspaceDb.workspaceId, threadId, materialId, revisionId, bindingMutationRequestId);
    if (consumed.changes === 1) {
      return 'consumed';
    }
    const binding = findBinding(workspaceDb, threadId, materialId);
    if (!binding) {
      throw materialError('recovery_required', 'The verified Material binding is missing.');
    }
    if (binding.lastMutationRequestId !== bindingMutationRequestId) {
      return 'superseded';
    }
    if (
      binding.bindingState === 'bound' &&
      binding.inclusionState === 'included' &&
      binding.latestQueuedRevisionId === null
    ) {
      return 'consumed';
    }
    throw materialError('recovery_required', 'The verified Material binding is contradictory.');
  })();
}

/** Creates a deterministic Material. @param workspaceDb Workspace database. @param input Accepted command. @returns Reserved identity. @throws A recovery error for an existing request owner. */
export function createWorkspaceMaterial(
  workspaceDb: WorkspaceDb,
  input: CreateWorkspaceMaterialInput
): CreateWorkspaceMaterialResponse {
  const materialId = deriveEntityId('mat', [
    'material.create',
    input.actor,
    workspaceDb.workspaceId,
    input.requestId,
  ]);
  return workspaceDb.sqlite.transaction(() => {
    if (findMaterial(workspaceDb, materialId)) {
      throw materialError('recovery_required', 'The request-owned Material has no receipt.');
    }
    workspaceDb.sqlite
      .prepare(`INSERT INTO workspace_materials (
        workspace_id, material_id, title, kind, current_revision_id, sensitivity,
        last_mutation_request_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`)
      .run(
        workspaceDb.workspaceId,
        materialId,
        input.title,
        input.kind,
        input.sensitivity,
        input.requestId,
        input.acceptedAt,
        input.acceptedAt
      );
    return { materialId };
  })();
}

/** Saves an immutable revision and coalesces bound queues. @param workspaceDb Workspace database. @param input Accepted command and base. @returns Material and revision ids. @throws An S16 digest, stale, conflict, or recovery error. */
export function saveWorkspaceMaterialRevision(
  workspaceDb: WorkspaceDb,
  input: SaveWorkspaceMaterialRevisionInput
): SaveWorkspaceMaterialRevisionResponse {
  const revisionId = deriveEntityId('mrev', [
    'material.save',
    input.actor,
    workspaceDb.workspaceId,
    input.materialId,
    input.requestId,
  ]);
  return workspaceDb.sqlite.transaction(() => {
    if (findRevision(workspaceDb, input.materialId, revisionId)) {
      throw materialError('recovery_required', 'The request-owned revision has no receipt.');
    }
    if (contentDigest(input.content) !== input.contentDigest) {
      throw materialError('source_digest_mismatch', 'Material content does not match its digest.');
    }
    const material = findMaterial(workspaceDb, input.materialId);
    if (!material) {
      throw materialError('stale', 'The requested Material does not exist.');
    }
    assertMaterialPointer(workspaceDb, material);
    const bindings = workspaceDb.sqlite
      .prepare(
        `${BINDING_SELECT} WHERE workspace_id = ? AND material_id = ? AND binding_state = 'bound'`
      )
      .all(workspaceDb.workspaceId, input.materialId) as BindingRow[];
    bindings.forEach((binding) => {
      assertBindingQueue(workspaceDb, binding, material);
    });
    if (material.currentRevisionId !== input.expectedRevisionId) {
      throw materialError('conflict', 'The Material current revision does not match the request.');
    }
    workspaceDb.sqlite
      .prepare(`INSERT INTO workspace_material_revisions (
        workspace_id, material_id, revision_id, parent_revision_id, media_type,
        content_digest, content, author_id, created_by_request_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        workspaceDb.workspaceId,
        input.materialId,
        revisionId,
        input.expectedRevisionId,
        material.kind === 'markdown' ? 'text/markdown' : 'text/plain',
        input.contentDigest,
        input.content,
        responsibleUserIdForActor(input.actor),
        input.requestId,
        input.acceptedAt
      );
    const pointer = workspaceDb.sqlite
      .prepare(`UPDATE workspace_materials
        SET current_revision_id = ?, last_mutation_request_id = ?, updated_at = ?
        WHERE workspace_id = ? AND material_id = ? AND current_revision_id IS ?`)
      .run(
        revisionId,
        input.requestId,
        input.acceptedAt,
        workspaceDb.workspaceId,
        input.materialId,
        input.expectedRevisionId
      );
    if (pointer.changes !== 1) {
      throw materialError('conflict', 'The Material current revision changed concurrently.');
    }
    workspaceDb.sqlite
      .prepare(`UPDATE thread_material_bindings
        SET latest_queued_revision_id = ?, last_mutation_request_id = ?, updated_at = ?
        WHERE workspace_id = ? AND material_id = ? AND binding_state = 'bound'`)
      .run(
        revisionId,
        input.requestId,
        input.acceptedAt,
        workspaceDb.workspaceId,
        input.materialId
      );
    return { materialId: input.materialId, revisionId };
  })();
}

/** Binds a Material under an exact precondition. @param workspaceDb Workspace database. @param input Accepted command. @returns Bound outcome. @throws A stale, conflict, or recovery error. */
export function bindThreadMaterial(
  workspaceDb: WorkspaceDb,
  input: BindThreadMaterialInput
): BindThreadMaterialResponse {
  return workspaceDb.sqlite.transaction(() => {
    const material = requireMaterial(workspaceDb, input.materialId);
    assertMaterialPointer(workspaceDb, material);
    const existing = findBinding(workspaceDb, input.threadId, input.materialId);
    assertFreshBinding(existing, input.requestId);
    if (existing?.bindingState === 'bound') {
      throw materialError('conflict', 'The Material binding state does not match the request.');
    }
    const bound = workspaceDb.sqlite
      .prepare(
        `${BINDING_SELECT} WHERE workspace_id = ? AND thread_id = ? AND binding_state = 'bound'`
      )
      .get(workspaceDb.workspaceId, input.threadId);
    if (bound) {
      throw materialError('conflict', 'The Thread already has a bound Material.');
    }
    if (existing) {
      workspaceDb.sqlite
        .prepare(`UPDATE thread_material_bindings SET
          binding_state = 'bound', latest_queued_revision_id = ?, inclusion_state = 'included',
          last_mutation_request_id = ?, updated_at = ?
          WHERE workspace_id = ? AND thread_id = ? AND material_id = ? AND binding_state = 'unbound'`)
        .run(
          material.currentRevisionId,
          input.requestId,
          input.acceptedAt,
          workspaceDb.workspaceId,
          input.threadId,
          input.materialId
        );
    } else {
      workspaceDb.sqlite
        .prepare(`INSERT INTO thread_material_bindings (
          workspace_id, thread_id, material_id, binding_state, latest_queued_revision_id,
          inclusion_state, last_mutation_request_id, created_at, updated_at
        ) VALUES (?, ?, ?, 'bound', ?, 'included', ?, ?, ?)`)
        .run(
          workspaceDb.workspaceId,
          input.threadId,
          input.materialId,
          material.currentRevisionId,
          input.requestId,
          input.acceptedAt,
          input.acceptedAt
        );
    }
    return { materialId: input.materialId, threadId: input.threadId, outcome: 'bound' as const };
  })();
}

/** Unbinds a Material while retaining history. @param workspaceDb Workspace database. @param input Accepted command. @returns Unbound outcome. @throws A stale, conflict, or recovery error. */
export function unbindThreadMaterial(
  workspaceDb: WorkspaceDb,
  input: UnbindThreadMaterialInput
): UnbindThreadMaterialResponse {
  return workspaceDb.sqlite.transaction(() => {
    const material = requireMaterial(workspaceDb, input.materialId);
    assertMaterialPointer(workspaceDb, material);
    const binding = findBinding(workspaceDb, input.threadId, input.materialId);
    assertFreshBinding(binding, input.requestId);
    if (binding) {
      assertBindingQueue(workspaceDb, binding, material);
    }
    if (!binding || binding.bindingState !== input.expectedBindingState) {
      throw materialError('conflict', 'The Material binding state does not match the request.');
    }
    workspaceDb.sqlite
      .prepare(`UPDATE thread_material_bindings SET
        binding_state = 'unbound', latest_queued_revision_id = NULL, inclusion_state = 'included',
        last_mutation_request_id = ?, updated_at = ?
        WHERE workspace_id = ? AND thread_id = ? AND material_id = ? AND binding_state = 'bound'`)
      .run(
        input.requestId,
        input.acceptedAt,
        workspaceDb.workspaceId,
        input.threadId,
        input.materialId
      );
    return { materialId: input.materialId, threadId: input.threadId, outcome: 'unbound' as const };
  })();
}

/** Excludes an exact queued revision. @param workspaceDb Workspace database. @param input Accepted command. @returns Excluded outcome. @throws A stale, conflict, or recovery error. */
export function excludeThreadMaterial(
  workspaceDb: WorkspaceDb,
  input: ExcludeThreadMaterialInput
): ExcludeThreadMaterialResponse {
  return workspaceDb.sqlite.transaction(() => {
    const material = requireMaterial(workspaceDb, input.materialId);
    assertMaterialPointer(workspaceDb, material);
    const binding = findBinding(workspaceDb, input.threadId, input.materialId);
    assertFreshBinding(binding, input.requestId);
    if (binding) {
      assertBindingQueue(workspaceDb, binding, material);
    }
    if (
      !binding ||
      binding.bindingState !== input.expectedBindingState ||
      binding.inclusionState !== input.expectedInclusionState ||
      binding.latestQueuedRevisionId !== input.expectedQueuedRevisionId
    ) {
      throw materialError('conflict', 'The queued Material binding does not match the request.');
    }
    workspaceDb.sqlite
      .prepare(`UPDATE thread_material_bindings SET
        inclusion_state = 'excluded', last_mutation_request_id = ?, updated_at = ?
        WHERE workspace_id = ? AND thread_id = ? AND material_id = ?
          AND binding_state = 'bound' AND inclusion_state = 'included'
          AND latest_queued_revision_id = ?`)
      .run(
        input.requestId,
        input.acceptedAt,
        workspaceDb.workspaceId,
        input.threadId,
        input.materialId,
        input.expectedQueuedRevisionId
      );
    return { materialId: input.materialId, threadId: input.threadId, outcome: 'excluded' as const };
  })();
}

/** Restores an excluded queue. @param workspaceDb Workspace database. @param input Accepted command. @returns Included outcome. @throws A stale, conflict, or recovery error. */
export function restoreThreadMaterial(
  workspaceDb: WorkspaceDb,
  input: RestoreThreadMaterialInput
): RestoreThreadMaterialResponse {
  return workspaceDb.sqlite.transaction(() => {
    const material = requireMaterial(workspaceDb, input.materialId);
    assertMaterialPointer(workspaceDb, material);
    const binding = findBinding(workspaceDb, input.threadId, input.materialId);
    assertFreshBinding(binding, input.requestId);
    if (binding) {
      assertBindingQueue(workspaceDb, binding, material);
    }
    if (
      !binding ||
      binding.bindingState !== input.expectedBindingState ||
      binding.inclusionState !== input.expectedInclusionState
    ) {
      throw materialError('conflict', 'The Material inclusion state does not match the request.');
    }
    workspaceDb.sqlite
      .prepare(`UPDATE thread_material_bindings SET
        inclusion_state = 'included', last_mutation_request_id = ?, updated_at = ?
        WHERE workspace_id = ? AND thread_id = ? AND material_id = ?
          AND binding_state = 'bound' AND inclusion_state = 'excluded'`)
      .run(
        input.requestId,
        input.acceptedAt,
        workspaceDb.workspaceId,
        input.threadId,
        input.materialId
      );
    return { materialId: input.materialId, threadId: input.threadId, outcome: 'included' as const };
  })();
}

/** Finds one Material row. @param db Workspace database. @param id Material id. @returns Row or undefined. */
function findMaterial(db: WorkspaceDb, id: string): MaterialRow | undefined {
  return db.sqlite
    .prepare(`${MATERIAL_SELECT} WHERE workspace_id = ? AND material_id = ?`)
    .get(db.workspaceId, id) as MaterialRow | undefined;
}

/** Requires one Material row. @param db Workspace database. @param id Material id. @returns Row. @throws A stale error when absent. */
function requireMaterial(db: WorkspaceDb, id: string): MaterialRow {
  const row = findMaterial(db, id);
  if (!row) {
    throw materialError('stale', 'The requested Material does not exist.');
  }
  return row;
}

/** Finds one revision row. @param db Workspace database. @param materialId Material id. @param revisionId Revision id. @returns Row or undefined. */
function findRevision(
  db: WorkspaceDb,
  materialId: string,
  revisionId: string
): RevisionRow | undefined {
  return db.sqlite
    .prepare(`${REVISION_SELECT} WHERE workspace_id = ? AND material_id = ? AND revision_id = ?`)
    .get(db.workspaceId, materialId, revisionId) as RevisionRow | undefined;
}

/** Finds one binding row. @param db Workspace database. @param threadId Thread id. @param materialId Material id. @returns Row or undefined. */
function findBinding(
  db: WorkspaceDb,
  threadId: string,
  materialId: string
): BindingRow | undefined {
  return db.sqlite
    .prepare(`${BINDING_SELECT} WHERE workspace_id = ? AND thread_id = ? AND material_id = ?`)
    .get(db.workspaceId, threadId, materialId) as BindingRow | undefined;
}

/** Rejects request-owned binding state without a receipt. @param row Existing binding. @param requestId Request id. @throws A recovery error for matching proof. */
function assertFreshBinding(row: BindingRow | undefined, requestId: string): void {
  if (row?.lastMutationRequestId === requestId) {
    throw materialError('recovery_required', 'The request-owned binding has no receipt.');
  }
}

/** Verifies a Material pointer. @param db Workspace database. @param row Material row. @throws A recovery error for invalid authority. */
function assertMaterialPointer(db: WorkspaceDb, row: MaterialRow): void {
  if (!row.currentRevisionId) {
    return;
  }
  const revision = findRevision(db, row.materialId, row.currentRevisionId);
  if (!revision) {
    throw materialError('recovery_required', 'The Material current revision is missing.');
  }
  assertRevisionContent(revision);
}

/** Verifies a queued revision. @param db Workspace database. @param row Binding row. @param material Owning Material. @returns Verified revision or undefined for an empty queue. @throws A recovery error for invalid authority. */
function assertBindingQueue(
  db: WorkspaceDb,
  row: BindingRow,
  material: MaterialRow
): RevisionRow | undefined {
  if (!row.latestQueuedRevisionId) {
    return undefined;
  }
  if (row.latestQueuedRevisionId !== material.currentRevisionId) {
    throw materialError('recovery_required', 'The bound Material queue is not current.');
  }
  const revision = findRevision(db, row.materialId, row.latestQueuedRevisionId);
  if (!revision) {
    throw materialError('recovery_required', 'The bound Material queue revision is missing.');
  }
  assertRevisionContent(revision);
  return revision;
}

/** Verifies stored revision bytes. @param row Revision row. @throws A recovery error for a digest mismatch. */
function assertRevisionContent(row: RevisionRow): void {
  if (contentDigest(row.content) !== row.contentDigest) {
    throw materialError('recovery_required', 'The stored Material revision digest is invalid.');
  }
}

/** Projects a closed Material view. @param row Authority row. @returns Public view. */
function toMaterialView(row: MaterialRow): WorkspaceMaterialView {
  return {
    workspaceId: row.workspaceId,
    materialId: row.materialId,
    title: row.title,
    kind: row.kind,
    currentRevisionId: row.currentRevisionId,
    sensitivity: row.sensitivity,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Projects a closed revision summary. @param row Authority row. @returns Public summary. */
function toRevisionSummary(row: RevisionRow): WorkspaceMaterialRevisionSummary {
  return {
    workspaceId: row.workspaceId,
    materialId: row.materialId,
    revisionId: row.revisionId,
    parentRevisionId: row.parentRevisionId,
    mediaType: row.mediaType,
    contentDigest: row.contentDigest,
    authorId: row.authorId,
    createdAt: row.createdAt,
  };
}

/** Projects a closed exact revision. @param row Authority row. @returns Public view. */
function toRevisionView(row: RevisionRow): WorkspaceMaterialRevisionView {
  return {
    ...toRevisionSummary(row),
    content: row.content,
    judgements: JudgementRecordReaderSchema.array().parse(JSON.parse(row.judgementsJson)),
  };
}

/** Computes the exact UTF-8 digest. @param content Canonical content. @returns SHA-256 digest. */
function contentDigest(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

/** Creates one S16 error. @param code Stable code. @param message Failure summary. @returns Typed error. */
function materialError(
  code: WorkspaceMaterialErrorCode,
  message: string
): Error & { readonly code: WorkspaceMaterialErrorCode; readonly status: 400 | 409 } {
  return new WorkspaceMaterialError(code, message);
}
