import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { CommandRequestResponse } from '../lib/store.js';
import { CATALOG_COMMAND_RECEIPTS } from './catalog-command-receipt-codecs.js';
import {
  commandRequestKey,
  mapCommandRequestRow,
  normalizeCommandRequestResponse,
} from './command-request-records.js';
import {
  CONTROL_NATIVE_CORE_LIFECYCLE_COMMANDS,
  CONTROL_NATIVE_RECEIPT_COMMANDS,
  CONTROL_NATIVE_WORKSPACE_KNOWLEDGE_COMMANDS,
  type ControlAdmission,
  type ControlAdmissionResult,
  ControlAdmissionSchema,
} from './control-store-admission-codecs.js';
import {
  type ControlProductOwner,
  ControlProductPreconditionError,
  decode as decodeControlProduct,
  readProduct,
} from './control-store-product-records.js';
import {
  applyControlProducts,
  assertControlProductWriter,
  type PreparedControlEntry,
} from './control-store-products.js';
import {
  SCOPED_NOTEBOOK_SERVER_RECEIPTS,
  SCOPED_NOTEBOOK_USER_RECEIPTS,
} from './scoped-notebook-sql-codecs.js';

/** Existing target annotations partition the shared judgement operation without changing its retained scope or adding ownership state. */
export const CONTROL_NATIVE_EVALUATION_RECEIPT_SQL = `(command_name='evaluation.judgement-add'
  AND response_kind='evaluation_judgement' AND response_id=request_id
  AND (EXISTS (SELECT 1 FROM artifact_reviews AS review, json_each(review.judgements) AS annotation
    WHERE review.workspace_id=json_extract(idempotency_requests.scope_json,'$.workspaceId')
      AND json_extract(annotation.value,'$.requestId')=idempotency_requests.request_id)
    OR EXISTS (SELECT 1 FROM workspace_material_revisions AS revision, json_each(revision.judgements) AS annotation
    WHERE revision.workspace_id=json_extract(idempotency_requests.scope_json,'$.workspaceId')
      AND json_extract(annotation.value,'$.requestId')=idempotency_requests.request_id)
    OR EXISTS (SELECT 1 FROM evaluation_candidate_sets AS candidate, json_each(candidate.payload_json,'$.judgements') AS annotation
    WHERE candidate.workspace_id=json_extract(idempotency_requests.scope_json,'$.workspaceId')
      AND json_extract(annotation.value,'$.requestId')=idempotency_requests.request_id)))`;

/** Verifies the actual physical receipt owner, without treating extra resource selectors as new authority. */
function assertReceiptOwner(owner: ControlProductOwner, scope: Record<string, string>): void {
  if (
    scope.userId !== undefined ||
    scope.appId !== undefined ||
    (owner.kind === 'server'
      ? scope.coreId !== 'server' || scope.workspaceId !== undefined
      : scope.workspaceId !== owner.workspaceId || scope.coreId !== undefined)
  )
    throw new ControlProductPreconditionError();
}

/** Prunes only this activated operation/scope partition; never touches another owner's receipts or Audit rows. */
export function pruneControlAdmissionReceipts(
  sqlite: Database.Database,
  owner: ControlProductOwner | { readonly kind: 'user'; readonly userId: string },
  referenceTime: string
): void {
  assertControlProductWriter(sqlite);
  z.string().datetime().parse(referenceTime);
  if (owner.kind === 'user') {
    sqlite
      .prepare(
        `DELETE FROM idempotency_requests WHERE schema_version=1 AND expires_at<=? AND command_name IN (${SCOPED_NOTEBOOK_USER_RECEIPTS.map(() => '?').join(',')}) AND json_extract(scope_json,'$.userId')=? AND json_extract(scope_json,'$.coreId') IS NULL AND json_extract(scope_json,'$.workspaceId') IS NULL AND json_extract(scope_json,'$.appId') IS NULL`
      )
      .run(referenceTime, ...SCOPED_NOTEBOOK_USER_RECEIPTS, owner.userId);
    return;
  }
  const scope =
    owner.kind === 'server'
      ? "json_extract(scope_json,'$.coreId')='server' AND json_extract(scope_json,'$.workspaceId') IS NULL"
      : "json_extract(scope_json,'$.workspaceId')=? AND json_extract(scope_json,'$.coreId') IS NULL";
  const commands =
    owner.kind === 'workspace'
      ? [
          ...CONTROL_NATIVE_RECEIPT_COMMANDS,
          ...CONTROL_NATIVE_WORKSPACE_KNOWLEDGE_COMMANDS,
          ...CATALOG_COMMAND_RECEIPTS,
        ]
      : [
          ...CONTROL_NATIVE_RECEIPT_COMMANDS,
          ...CONTROL_NATIVE_CORE_LIFECYCLE_COMMANDS,
          ...SCOPED_NOTEBOOK_SERVER_RECEIPTS,
        ];
  sqlite
    .prepare(
      `DELETE FROM idempotency_requests WHERE schema_version=1 AND expires_at<=? AND (command_name IN (${commands.map(() => '?').join(',')})${owner.kind === 'workspace' ? ` OR ${CONTROL_NATIVE_EVALUATION_RECEIPT_SQL}` : ''}) AND ${scope} AND json_extract(scope_json,'$.userId') IS NULL AND json_extract(scope_json,'$.appId') IS NULL`
    )
    .run(referenceTime, ...commands, ...(owner.kind === 'workspace' ? [owner.workspaceId] : []));
}

/** Applies the original receipt, required local Audit and complete product tuple in the caller's savepoint, never a nested commit. */
export function applyControlAdmission(
  sqlite: Database.Database,
  owner: ControlProductOwner,
  value: ControlAdmission,
  entries: readonly PreparedControlEntry[]
): ControlAdmissionResult {
  assertControlProductWriter(sqlite);
  const input = ControlAdmissionSchema.parse(value);
  const receipt = input.receipt;
  assertReceiptOwner(owner, receipt.scope);
  if (
    receipt.key !== commandRequestKey(receipt.command, receipt.requestId, receipt.scope) ||
    receipt.expiresAt <= receipt.createdAt
  )
    throw new ControlProductPreconditionError();
  let response = normalizeCommandRequestResponse(
    receipt.command,
    receipt.response as CommandRequestResponse
  );
  const prior = sqlite
    .prepare(
      'SELECT schema_version AS schemaVersion,request_key AS key,command_name AS command,request_id AS requestId,scope_json AS scopeJson,input_hash AS inputHash,response_kind AS responseKind,response_id AS responseId,response_json AS responseJson,created_at AS createdAt,expires_at AS expiresAt FROM idempotency_requests WHERE request_key=?'
    )
    .get(receipt.key) as Parameters<typeof mapCommandRequestRow>[0] | undefined;
  if (prior && prior.expiresAt > receipt.createdAt) {
    // Retained descriptive additions use the frozen reader, never the stricter current writer parser.
    const retained = mapCommandRequestRow(prior);
    if (
      retained.command !== receipt.command ||
      retained.requestId !== receipt.requestId ||
      !isDeepStrictEqual(retained.scope, receipt.scope) ||
      retained.inputHash !== receipt.inputHash
    )
      throw new ControlProductPreconditionError();
    return { replayed: true, response: retained.response };
  }
  let products = input.products;
  let event = input.audit;
  if (receipt.command === 'thread.create' && owner.kind === 'workspace') {
    const threads = input.products.filter((product) => product.kind === 'thread');
    if (threads.length === 1) {
      const candidate = decodeControlProduct('thread', threads[0]!.record, owner);
      if (candidate.visibility === 'private' && candidate.entryPath === 'conversation') {
        if (
          threads[0]!.expectedRevision !== 0 ||
          typeof candidate.privateOwnerUserId !== 'string' ||
          input.entries.length > 0 ||
          input.products.some(
            (product) => product.kind !== 'thread' && product.kind !== 'workspace'
          )
        )
          throw new ControlProductPreconditionError();
        for (const product of input.products)
          decodeControlProduct(product.kind, product.record, owner);
        const selected = sqlite
          .prepare(
            "SELECT id FROM control_threads WHERE json_extract(record_json,'$.visibility')='private' AND json_extract(record_json,'$.entryPath')='conversation' AND json_extract(record_json,'$.privateOwnerUserId')=? ORDER BY julianday(json_extract(record_json,'$.createdAt')),id LIMIT 1"
          )
          .get(candidate.privateOwnerUserId) as { id: string } | undefined;
        if (selected) {
          // Selection is native and preserves existing, including archived, history even when fresh commands race.
          const existing = readProduct(sqlite, owner, 'thread', selected.id);
          if (!existing) throw new ControlProductPreconditionError();
          response = { kind: 'thread', id: selected.id };
          products = [];
          event = { ...event, threadId: selected.id, resource: `thread:${selected.id}` };
        }
      }
    }
  }
  if (
    event.action !== receipt.command ||
    event.requestId !== receipt.requestId ||
    event.workspaceId !== (owner.kind === 'workspace' ? owner.workspaceId : null) ||
    event.outcome !== 'succeeded'
  )
    throw new ControlProductPreconditionError();
  pruneControlAdmissionReceipts(sqlite, owner, receipt.createdAt);
  applyControlProducts(sqlite, owner, products, entries);
  const targetKind =
    response.kind === 'thread' ? 'thread' : response.kind === 'turn' ? 'turn' : null;
  if (
    !targetKind ||
    !sqlite
      .prepare(
        `SELECT 1 FROM ${targetKind === 'thread' ? 'control_threads' : 'control_turns'} WHERE id=?`
      )
      .get(response.id)
  )
    throw new ControlProductPreconditionError();
  sqlite
    .prepare(
      'INSERT INTO idempotency_requests (schema_version,request_key,command_name,request_id,scope_json,input_hash,response_kind,response_id,response_json,created_at,expires_at) VALUES (1,?,?,?,?,?,?,?,?,?,?)'
    )
    .run(
      receipt.key,
      receipt.command,
      receipt.requestId,
      JSON.stringify(receipt.scope),
      receipt.inputHash,
      response.kind,
      response.id,
      response.conversationMetadata === undefined
        ? null
        : JSON.stringify(response.conversationMetadata),
      receipt.createdAt,
      receipt.expiresAt
    );
  // Same retained Audit shape, but a separate logical row-family owner; no call through a main-thread writer or fake Store.
  const audit = {
    schema_version: 1,
    audit_event_id: event.id,
    workspace_id: event.workspaceId,
    protocol_version: event.protocolVersion ?? null,
    thread_id: event.threadId,
    turn_id: event.turnId,
    item_id: event.itemId,
    capability_call_id: event.capabilityCallId,
    permission_decision_id: event.permissionDecisionId,
    vault_grant_id: event.vaultGrantId,
    request_id: event.requestId,
    actor_json: event.actor === null ? null : JSON.stringify(event.actor),
    authentication_json:
      event.authentication === undefined ? null : JSON.stringify(event.authentication),
    subject_json: event.subject === null ? null : JSON.stringify(event.subject),
    agent_id: event.agentId,
    agent_session_id: event.agentSessionId,
    category: event.category,
    action: event.action,
    resource: event.resource,
    resource_revision: event.resourceRevision,
    notebook_admission_json:
      event.notebookAdmission === undefined ? null : JSON.stringify(event.notebookAdmission),
    policy_invocation_json:
      event.policyInvocation === undefined ? null : JSON.stringify(event.policyInvocation),
    policy_write_outcome_json:
      event.policyWriteOutcome === undefined ? null : JSON.stringify(event.policyWriteOutcome),
    outcome: event.outcome,
    severity: event.severity,
    summary: event.summary,
    error_code: event.errorCode,
    created_at: event.createdAt,
    occurred_at: event.occurredAt,
  };
  const columns = Object.keys(audit);
  sqlite
    .prepare(
      `INSERT INTO audit_events (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`
    )
    .run(...Object.values(audit));
  return { replayed: false, response };
}
