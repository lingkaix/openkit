import { isAbsolute } from 'node:path';
import { GoalViewSchema } from '@openkit/app-api-schemas';
import {
  type ControlReviewCommandInput,
  ControlReviewCommandInputSchema,
  type ControlReviewCommandResult,
  ControlReviewCommandResultSchema,
} from '../artifact-reviews.js';
import {
  type ControlMaintenanceAdmissionInput,
  ControlMaintenanceAdmissionInputSchema,
  type ControlMaintenanceAdmissionResult,
  ControlMaintenanceAdmissionResultSchema,
} from '../knowledge/knowledge-agent-maintenance.js';
import {
  type ControlExecutionJournalInput,
  ControlExecutionJournalInputSchema,
} from '../runtime/execution-journal.js';
import {
  type ControlGoalCommandInput,
  ControlGoalCommandInputSchema,
  type ControlGoalCommandResult,
} from '../runtime/goal-owner.js';
import {
  type ControlPendingCommandResult,
  ControlPendingCommandResultSchema,
} from '../runtime/pending-requests.js';
import {
  type ProjectWorkerBackendCleanupInput,
  ProjectWorkerBackendCleanupInputSchema,
  type WorkerBackendCleanupProjectionResult,
  WorkerBackendCleanupProjectionResultSchema,
} from '../runtime/worker-backend-cleanup-projection.js';
import {
  type ControlMaterialCommandResult,
  ControlMaterialCommandResultSchema,
  type ControlMaterialWireInput,
  ControlMaterialWireInputSchema,
  controlMaterialTextSpans,
} from '../workspace-materials.js';
import {
  type ControlAdmission,
  type ControlAdmissionResult,
  ControlAdmissionSchema,
} from './control-store-admission.js';
import {
  type ControlPendingTransition,
  ControlPendingTransitionSchema,
} from './control-store-pending.js';
import {
  CONTROL_PRODUCT_LIMITS,
  type ControlProductContentMount,
  ControlProductContentMountSchema,
  type ControlProductOwner,
  type ControlProductTransition,
  ControlProductTransitionSchema,
  type ControlPublicationInput,
  ControlPublicationInputSchema,
  type ControlTerminalResult,
  type ControlTerminalTransition,
  ControlTerminalTransitionSchema,
} from './control-store-products.js';
import { StoredWorkOwnerV1Schema } from './retained-work-metadata-v1.js';
import {
  type ControlWorkObservationInput,
  ControlWorkObservationInputSchema,
  type ControlWorkObservationResult,
  parseWorkObservationRecord,
} from './work-observations.js';

/** Internal wire version; effect-bearing initialization requires matching peers, not a retained-format migration. */
export const CONTROL_WORKER_VERSION = 8;

/** Fixed, qualified batching and per-database pending admission bounds. */
export const CONTROL_WORKER_LIMITS = {
  batchTransitions: 32,
  batchWaitMs: 5,
  pendingTransitions: 1024,
  /** Process-wide binary input plus echoed range-text capacity, admitted before postMessage. */
  materialPendingBytes: 64 * 1024 * 1024,
} as const;

/** SQLite bind values that survive structured cloning without executable content. */
export type ControlSqlValue = string | number | bigint | Uint8Array | null;

/** One fully materialized SQLite row; no cursor crosses the worker boundary. */
export type ControlSqlRow = Record<string, ControlSqlValue>;

/**
 * One trusted, bounded SQLite statement in a local transition.
 *
 * SQL and statement order come from Core code, never a public request. Conditions belong in SQL predicates and these in-worker assertions, not a main-thread read/decision round trip. Bind caller data; synchronize immutable inputs first. There are no callbacks, result references, external effects or transaction SQL.
 */
export type ControlSqlStatement =
  | {
      readonly mode: 'run';
      readonly sql: string;
      readonly parameters: readonly ControlSqlValue[];
      /** A conditional mutation must affect this many rows or roll back its transition. */
      readonly expectChanges?: number;
    }
  | {
      readonly mode: 'get';
      readonly sql: string;
      readonly parameters: readonly ControlSqlValue[];
      /** Check existence inside the same savepoint as all dependent mutations. */
      readonly expectRow?: 'present' | 'absent';
    };

/** A statement result, available to the caller only after durable outer COMMIT. */
export type ControlSqlResult =
  | { readonly mode: 'run'; readonly changes: number; readonly lastInsertRowid: number | bigint }
  | { readonly mode: 'get'; readonly row: ControlSqlRow | null };

/** Existing journals that require no app-specific recovery-copy callback. */
export type ControlInitializationScope = 'core' | 'user' | 'workspace';

/**
 * Trusted internal database-worker requests.
 *
 * An id is transient message correlation, never a replacement command receipt. A database key denotes an already-admitted physical scope, not new ownership. The host must cap outstanding writes before postMessage using the same pending bound: a worker-side cap alone cannot bound a blocked MessagePort's backlog. Pure reads use separate read-only/query_only connections and do not use this API.
 */
export type ControlWorkerCommand =
  | { readonly operation: 'shutdown' }
  | ({ readonly database: string } & (
      | {
          readonly operation: 'open';
          /** Absolute, admitted path with an existing parent; never a public path argument. */
          readonly path: string;
          /** Explicit fresh-scope admission; false must never initialize a missing database. */
          readonly create: boolean;
          /** Apply the existing scope journal before opening completes; never bypass app recovery. */
          readonly initialize?: ControlInitializationScope;
          /** Explicit admitted product owner; absent on legacy primitive-only fixture scopes. */
          readonly productOwner?: ControlProductOwner;
          /** Exact admitted root for same-connection scoped domain bodies; never inferred from a caller-selected database key. */
          readonly dataRoot?: string;
          /** Admitted private Storage binding; never derived from an incoming content locator. */
          readonly contentMount?: ControlProductContentMount;
        }
      | { readonly operation: 'write'; readonly statements: readonly ControlSqlStatement[] }
      | { readonly operation: 'transition'; readonly transition: ControlAdmission }
      | { readonly operation: 'products'; readonly transition: ControlProductTransition }
      | { readonly operation: 'publication'; readonly input: ControlPublicationInput }
      | { readonly operation: 'project-cleanup'; readonly input: ProjectWorkerBackendCleanupInput }
      | { readonly operation: 'observation'; readonly input: ControlWorkObservationInput }
      | { readonly operation: 'goal'; readonly input: ControlGoalCommandInput }
      | { readonly operation: 'journal'; readonly input: ControlExecutionJournalInput }
      | { readonly operation: 'pending'; readonly input: ControlPendingTransition }
      | { readonly operation: 'maintenance'; readonly input: ControlMaintenanceAdmissionInput }
      | {
          readonly operation: 'material';
          readonly input: ControlMaterialWireInput;
          readonly content?: ArrayBuffer;
        }
      | { readonly operation: 'review'; readonly input: ControlReviewCommandInput }
      | { readonly operation: 'terminal'; readonly input: ControlTerminalTransition }
      | { readonly operation: 'checkpoint' | 'reclaim' | 'close' }
    ));

/** Transient correlation header; the command receipt remains in the owning SQL tuple. */
export type ControlWorkerRequest = ControlWorkerCommand & {
  readonly version: typeof CONTROL_WORKER_VERSION;
  readonly id: number;
};

/** Closed failure categories; SQL text, bindings and native error messages are not returned. */
export const CONTROL_WORKER_FAILURE_CODES = [
  'invalid-request',
  'not-open',
  'busy',
  'precondition',
  'constraint',
  'sql-failed',
  'unavailable',
  'commit-unknown',
  'migration_missing',
  'migration_failed',
  'integrity',
] as const;

/** Closed native failure code, with no SQL text or bound values. */
export type ControlWorkerFailureCode = (typeof CONTROL_WORKER_FAILURE_CODES)[number];

/** Trusted domain refusals preserve the existing public contract; native SQL diagnostics never enter this projection. */
export interface ControlWorkerDomainRefusal {
  readonly operation: 'goal' | 'maintenance' | 'material' | 'review' | 'pending';
  readonly code: string;
  readonly message: string;
  readonly status: number;
}

/**
 * Worker reply. Success for writes follows the outer FULL-durability COMMIT.
 *
 * Worker loss, missing replies and commit-unknown are not proof of non-commit. Inspect the original command receipt under its identity/fingerprint; this transport neither retries nor supplies another durable queue or recovery owner.
 */
export type ControlWorkerReply = {
  readonly version: typeof CONTROL_WORKER_VERSION;
  readonly id: number;
} & (
  | {
      readonly status: 'ok';
      readonly operation: 'open' | 'close' | 'shutdown' | 'products' | 'publication';
    }
  | { readonly status: 'ok'; readonly operation: 'journal'; readonly resultJson: string }
  | {
      readonly status: 'ok';
      readonly operation: 'pending';
      readonly result: ControlPendingCommandResult;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'write';
      readonly results: readonly ControlSqlResult[];
    }
  | {
      readonly status: 'ok';
      readonly operation: 'transition';
      readonly result: ControlAdmissionResult;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'project-cleanup';
      readonly result: WorkerBackendCleanupProjectionResult;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'observation';
      readonly result: ControlWorkObservationResult;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'goal';
      readonly result: ControlGoalCommandResult;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'maintenance';
      readonly result: ControlMaintenanceAdmissionResult;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'material';
      readonly result: ControlMaterialCommandResult;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'review';
      readonly result: ControlReviewCommandResult;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'terminal';
      readonly result: ControlTerminalResult;
    }
  | {
      readonly status: 'ok';
      readonly operation: 'checkpoint';
      readonly pressure: {
        readonly busy: number;
        readonly log: number;
        readonly checkpointed: number;
        readonly walBytes: number;
        readonly walAgeMs: number;
      };
    }
  | { readonly status: 'ok'; readonly operation: 'reclaim'; readonly complete: boolean }
  | {
      readonly status: 'error';
      readonly code: ControlWorkerFailureCode;
      readonly commit: 'not-committed' | 'unknown';
      readonly domain?: ControlWorkerDomainRefusal;
    }
);

/** Checks cloneable SQLite values without accepting non-finite or executable content. */
export function isControlSqlValue(value: unknown): value is ControlSqlValue {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'bigint' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (value instanceof Uint8Array && !(value.buffer instanceof SharedArrayBuffer))
  );
}

/** Recognizes data records, not dates, binary buffers, arrays or other native objects. */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Checks a materialized result; no iterator or callback may cross the boundary. */
function isSqlResult(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const result = value;
  if (result.mode === 'run') {
    return (
      Number.isSafeInteger(result.changes) &&
      (result.changes as number) >= 0 &&
      (typeof result.lastInsertRowid === 'bigint' || Number.isSafeInteger(result.lastInsertRowid))
    );
  }
  return (
    result.mode === 'get' &&
    (result.row === null ||
      (isRecord(result.row) && Object.values(result.row).every(isControlSqlValue)))
  );
}

/** Validates only a trusted, bounded domain refusal, never an arbitrary native exception or SQL message. */
function isDomainRefusal(value: unknown): value is ControlWorkerDomainRefusal {
  return (
    isRecord(value) &&
    exactFields(value, ['operation', 'code', 'message', 'status']) &&
    // This reserved owner refusal carries no native exception text or SQL details.
    (value.code !== 'unsupported_retained_format' ||
      (value.operation === 'goal' &&
        value.message === 'Unsupported retained record format.' &&
        value.status === 409)) &&
    (value.operation === 'goal' ||
      value.operation === 'pending' ||
      ((value.operation === 'material' || value.operation === 'review') &&
        ((['stale', 'conflict', 'recovery_required', 'idempotency_key_conflict'].includes(
          String(value.code)
        ) &&
          value.status === 409) ||
          (['source_digest_mismatch', 'invalid_request'].includes(String(value.code)) &&
            value.status === 400) ||
          (value.code === 'not_found' && value.status === 404))) ||
      (value.operation === 'maintenance' &&
        ((value.code === 'invalid_request' && value.status === 400) ||
          ((value.code === 'recovery_required' || value.code === 'idempotency_key_conflict') &&
            value.status === 409)))) &&
    typeof value.code === 'string' &&
    value.code.length > 0 &&
    value.code.length <= 128 &&
    typeof value.message === 'string' &&
    Buffer.byteLength(value.message) <= CONTROL_PRODUCT_LIMITS.metadataBytes &&
    Number.isInteger(value.status) &&
    (value.status as number) >= 400 &&
    (value.status as number) <= 599
  );
}

/**
 * Checks worker replies before a caller promise can be completed.
 *
 * Unknown additive fields are ignored; unknown versions, operations and core result values fail closed.
 *
 * @param value Structured-cloned message from the dedicated writer.
 * @returns Whether its closed core has a supported meaning.
 */
export function isControlWorkerReply(value: unknown): value is ControlWorkerReply {
  if (!isRecord(value)) return false;
  const reply = value;
  if (
    reply.version !== CONTROL_WORKER_VERSION ||
    !Number.isSafeInteger(reply.id) ||
    (reply.id as number) < 0
  )
    return false;
  if (reply.status === 'error') {
    return (
      CONTROL_WORKER_FAILURE_CODES.some((code) => code === reply.code) &&
      (reply.commit === 'not-committed' || reply.commit === 'unknown') &&
      (reply.domain === undefined ||
        (reply.code === 'precondition' &&
          reply.commit === 'not-committed' &&
          isDomainRefusal(reply.domain)))
    );
  }
  if (reply.status !== 'ok') return false;
  if (
    reply.operation === 'open' ||
    reply.operation === 'close' ||
    reply.operation === 'shutdown' ||
    reply.operation === 'products' ||
    reply.operation === 'publication'
  )
    return true;
  if (reply.operation === 'project-cleanup')
    return WorkerBackendCleanupProjectionResultSchema.safeParse(reply.result).success;
  if (reply.operation === 'observation') {
    if (
      !isRecord(reply.result) ||
      (reply.result.disposition !== 'committed' && reply.result.disposition !== 'duplicate')
    )
      return false;
    try {
      const observation = parseWorkObservationRecord(reply.result.observation);
      if (reply.result.publication === null) return true;
      const publication = parseWorkObservationRecord(reply.result.publication);
      return publication.type === 'content.published' && publication.parent === observation.id;
    } catch {
      return false;
    }
  }
  if (reply.operation === 'terminal') {
    const result = reply.result;
    return (
      isRecord(result) &&
      typeof result.turnId === 'string' &&
      result.turnId.length > 0 &&
      Number.isSafeInteger(result.revision) &&
      (result.revision as number) > 0 &&
      typeof result.replayed === 'boolean' &&
      (result.reap === null ||
        (isRecord(result.reap) &&
          typeof result.reap.id === 'string' &&
          result.reap.id.length > 0 &&
          Number.isSafeInteger(result.reap.sequence) &&
          (result.reap.sequence as number) > 0)) &&
      (result.response === null ||
        (isRecord(result.response) &&
          result.response.kind === 'turn' &&
          result.response.id === result.turnId)) &&
      (result.execution === null ||
        (isRecord(result.execution) &&
          typeof result.execution.executionId === 'string' &&
          result.execution.executionId.length > 0 &&
          Number.isSafeInteger(result.execution.revision) &&
          (result.execution.revision as number) > 0 &&
          (result.execution.phase === 'closing' || result.execution.phase === 'closed')))
    );
  }
  if (reply.operation === 'pending')
    return ControlPendingCommandResultSchema.safeParse(reply.result).success;
  if (reply.operation === 'journal')
    return (
      typeof reply.resultJson === 'string' &&
      Buffer.byteLength(reply.resultJson) <= CONTROL_PRODUCT_LIMITS.payloadBytes
    );
  if (reply.operation === 'review')
    return ControlReviewCommandResultSchema.safeParse(reply.result).success;
  if (reply.operation === 'material')
    return ControlMaterialCommandResultSchema.safeParse(reply.result).success;
  if (reply.operation === 'maintenance')
    return ControlMaintenanceAdmissionResultSchema.safeParse(reply.result).success;
  if (reply.operation === 'goal') {
    return (
      isRecord(reply.result) &&
      typeof reply.result.replayed === 'boolean' &&
      GoalViewSchema.safeParse(reply.result.view).success &&
      (reply.result.refusal === null ||
        (isRecord(reply.result.refusal) &&
          isDomainRefusal({ ...reply.result.refusal, operation: 'goal' })))
    );
  }
  if (reply.operation === 'write')
    return Array.isArray(reply.results) && reply.results.every(isSqlResult);
  if (reply.operation === 'transition') {
    return (
      isRecord(reply.result) &&
      typeof reply.result.replayed === 'boolean' &&
      isRecord(reply.result.response) &&
      ['thread', 'turn'].includes(String(reply.result.response.kind)) &&
      typeof reply.result.response.id === 'string' &&
      reply.result.response.id.length > 0
    );
  }
  if (reply.operation === 'reclaim') return typeof reply.complete === 'boolean';
  if (reply.operation !== 'checkpoint' || !isRecord(reply.pressure)) return false;
  const pressure = reply.pressure as Record<string, unknown>;
  return (
    Number.isSafeInteger(pressure.busy) &&
    (pressure.busy as number) >= 0 &&
    Number.isSafeInteger(pressure.log) &&
    (pressure.log as number) >= -1 &&
    Number.isSafeInteger(pressure.checkpointed) &&
    (pressure.checkpointed as number) >= -1 &&
    Number.isSafeInteger(pressure.walBytes) &&
    (pressure.walBytes as number) >= 0 &&
    typeof pressure.walAgeMs === 'number' &&
    Number.isFinite(pressure.walAgeMs) &&
    pressure.walAgeMs >= 0
  );
}

/** Removes quoted data/identifiers and comments only for the narrow SQL admission checks. */
function sqlCode(sql: string): string {
  // SQLite ends -- comments only at LF; a CR and any quotes after it are still comment data.
  return sql.replace(
    /--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]/g,
    ' '
  );
}

/** Refuses SQLite semantics that can roll back an outer batch instead of one savepoint. */
export function hasControlSqlRollback(sql: string): boolean {
  return /\bROLLBACK\b/i.test(sqlCode(sql));
}

/** Effect messages have exact keys; no unknown assertion can silently disappear. */
function exactFields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

/** Checks a trusted SQL step without permitting transaction control or shared mutable bindings. */
function isSqlStatement(value: unknown): value is ControlSqlStatement {
  if (!isRecord(value) || typeof value.sql !== 'string' || !Array.isArray(value.parameters))
    return false;
  if (
    !/^(SELECT|WITH|INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|EXPLAIN|VALUES)\b/i.test(
      sqlCode(value.sql).trimStart()
    ) ||
    hasControlSqlRollback(value.sql)
  )
    return false;
  if (!value.parameters.every(isControlSqlValue)) return false;
  if (value.mode === 'run') {
    return (
      exactFields(value, ['mode', 'sql', 'parameters'], ['expectChanges']) &&
      (value.expectChanges === undefined ||
        (Number.isSafeInteger(value.expectChanges) && (value.expectChanges as number) >= 0))
    );
  }
  return (
    value.mode === 'get' &&
    exactFields(value, ['mode', 'sql', 'parameters'], ['expectRow']) &&
    (value.expectRow === undefined || value.expectRow === 'present' || value.expectRow === 'absent')
  );
}

/** Reads only an ordinary, fixed, attached ArrayBuffer; native getters reject forged or shared backing. */
export function controlMaterialArrayBufferByteLength(value: unknown): number | undefined {
  try {
    if (!(value instanceof ArrayBuffer)) return undefined;
    const prototype = ArrayBuffer.prototype;
    const byteLength = Object.getOwnPropertyDescriptor(prototype, 'byteLength')!.get!.call(
      value
    ) as number;
    if (
      Object.getOwnPropertyDescriptor(prototype, 'resizable')?.get?.call(value) ||
      Object.getOwnPropertyDescriptor(prototype, 'detached')?.get?.call(value)
    )
      return undefined;
    return byteLength;
  } catch {
    return undefined;
  }
}

/** Bounds contiguous binary fields and reserves the UTF-8 text echoed by range replies until settlement. */
export function controlMaterialTransferSize(
  input: ControlMaterialWireInput
): { byteLength: number; replyByteLength: number } | undefined {
  let byteLength = 0;
  for (const span of controlMaterialTextSpans(input)) {
    if (span.offset !== byteLength || !Number.isSafeInteger(byteLength + span.byteLength))
      return undefined;
    byteLength += span.byteLength;
  }
  return {
    byteLength,
    replyByteLength:
      input.mode === 'range-correct' || input.mode === 'range-judgement' ? byteLength : 0,
  };
}

/**
 * Validates the complete effect-bearing request before posting and again before native admission.
 *
 * @param value Proposed message including its transient correlation header.
 * @returns Whether every effect/assertion is supported; unknown fields fail closed.
 */
export function isControlWorkerRequest(value: unknown): value is ControlWorkerRequest {
  if (
    !isRecord(value) ||
    value.version !== CONTROL_WORKER_VERSION ||
    !Number.isSafeInteger(value.id) ||
    (value.id as number) < 0
  )
    return false;
  const header = ['version', 'id', 'operation'];
  if (value.operation === 'shutdown') return exactFields(value, header);
  if (typeof value.database !== 'string' || value.database.length === 0) return false;
  const scoped = [...header, 'database'];
  if (value.operation === 'open') {
    return (
      exactFields(
        value,
        [...scoped, 'path', 'create'],
        ['initialize', 'productOwner', 'dataRoot', 'contentMount']
      ) &&
      typeof value.path === 'string' &&
      isAbsolute(value.path) &&
      typeof value.create === 'boolean' &&
      (value.dataRoot === undefined ||
        (typeof value.dataRoot === 'string' && isAbsolute(value.dataRoot))) &&
      (value.productOwner === undefined ||
        StoredWorkOwnerV1Schema.safeParse(value.productOwner).success) &&
      (value.contentMount === undefined ||
        (ControlProductContentMountSchema.safeParse(value.contentMount).success &&
          isAbsolute((value.contentMount as ControlProductContentMount).root))) &&
      (value.initialize === undefined ||
        value.initialize === 'core' ||
        value.initialize === 'user' ||
        value.initialize === 'workspace')
    );
  }
  if (value.operation === 'transition' || value.operation === 'products') {
    try {
      const schema =
        value.operation === 'transition' ? ControlAdmissionSchema : ControlProductTransitionSchema;
      return (
        exactFields(value, [...scoped, 'transition']) &&
        schema.safeParse(value.transition).success &&
        JSON.stringify(value.transition).length <= 2 * 1024 * 1024
      );
    } catch {
      return false;
    }
  }
  if (value.operation === 'material') {
    try {
      const parsed = ControlMaterialWireInputSchema.safeParse(value.input);
      if (!parsed.success || !exactFields(value, [...scoped, 'input'], ['content'])) return false;
      const size = controlMaterialTransferSize(parsed.data);
      if (!size) return false;
      const hasContent = controlMaterialTextSpans(parsed.data).length > 0;
      return (
        (hasContent
          ? controlMaterialArrayBufferByteLength(value.content) === size.byteLength
          : value.content === undefined) &&
        Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
      );
    } catch {
      return false;
    }
  }
  if (
    value.operation === 'publication' ||
    value.operation === 'pending' ||
    value.operation === 'journal' ||
    value.operation === 'project-cleanup' ||
    value.operation === 'observation' ||
    value.operation === 'goal' ||
    value.operation === 'maintenance' ||
    value.operation === 'review' ||
    value.operation === 'terminal'
  ) {
    try {
      const schema =
        value.operation === 'publication'
          ? ControlPublicationInputSchema
          : value.operation === 'pending'
            ? ControlPendingTransitionSchema
            : value.operation === 'journal'
              ? ControlExecutionJournalInputSchema
              : value.operation === 'project-cleanup'
                ? ProjectWorkerBackendCleanupInputSchema
                : value.operation === 'goal'
                  ? ControlGoalCommandInputSchema
                  : value.operation === 'review'
                    ? ControlReviewCommandInputSchema
                    : value.operation === 'maintenance'
                      ? ControlMaintenanceAdmissionInputSchema
                      : value.operation === 'terminal'
                        ? ControlTerminalTransitionSchema
                        : ControlWorkObservationInputSchema;
      return (
        exactFields(value, [...scoped, 'input']) &&
        schema.safeParse(value.input).success &&
        Buffer.byteLength(JSON.stringify(value.input)) <= CONTROL_PRODUCT_LIMITS.payloadBytes
      );
    } catch {
      return false;
    }
  }
  if (value.operation === 'write')
    return (
      exactFields(value, [...scoped, 'statements']) &&
      Array.isArray(value.statements) &&
      value.statements.length > 0 &&
      value.statements.every(isSqlStatement)
    );
  return (
    (value.operation === 'checkpoint' ||
      value.operation === 'reclaim' ||
      value.operation === 'close') &&
    exactFields(value, scoped)
  );
}
