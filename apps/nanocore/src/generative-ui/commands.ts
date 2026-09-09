import { createHash, randomUUID } from 'node:crypto';
import type {
  GenerativePresentation,
  GenerativePresentationDataModelResponse,
  GenerativePresentationResourceResponse,
  GenerativeUiA2uiAction,
  GenerativeUiAction,
  GenerativeUiItemSource,
  GenerativeUiKernelRecordsSource,
  LightAppAdmittedField,
  LightAppRecord,
  PublishGenerativePresentationRequest,
} from '@openkit/app-api-schemas';
import {
  GENERATIVE_UI_NATIVE_CATALOG_ID,
  GENERATIVE_UI_PROTOCOL_VERSION,
} from '@openkit/app-api-schemas';
import type { ActorRef, Item } from '@openkit/protocol';

import { recordWorkspaceAuditEvent } from '../audit-events.js';
import {
  getLightApp,
  listRecords,
  updateRecord,
  type KernelCommandContext,
} from '../generative-kernel/commands.js';
import { KernelCommandError } from '../generative-kernel/errors.js';
import type { FsStore } from '../lib/store.js';
import { runIdempotentCommand } from '../runtime/idempotent-command.js';
import type { WorkspaceDb } from '../storage/db.js';
import {
  admitProducerMessages,
  bindingPath,
  type AdmittedDeclaration,
} from './admit.js';

const ACCEPTED_MESSAGE_BYTE_LIMIT = 2 * 1024 * 1024;
const ACTION_MESSAGE_BYTE_LIMIT = 64 * 1024;
const WRITABLE_TURN_STATUSES = new Set(['pending', 'running', 'awaiting_human']);

/** Command context for Generative UI mutations and reads. */
export interface GenerativeUiCommandContext extends KernelCommandContext {
  /** Open Workspace database that owns presentations. */
  readonly workspaceDb: WorkspaceDb;
}

/** SQLite row for one retained presentation. */
interface PresentationRow {
  presentation_id: string;
  workspace_id: string;
  thread_id: string;
  turn_id: string;
  item_id: string;
  created_at: string;
  actor_json: string;
  request_id: string | null;
  origin_request_id: string | null;
  semantic_input_hash: string;
  title: string;
  fallback_text: string;
  protocol_version: string;
  catalog_id: string;
  messages_json: string;
  content_digest: string;
  source_json: string;
  actions_json: string;
  observed_at: string;
}

/**
 * Publishes one admitted native presentation and its Item reference.
 *
 * @param context Command context.
 * @param input Publish body.
 * @returns Retained presentation with derived publication.
 */
export async function publishGenerativePresentation(
  context: GenerativeUiCommandContext,
  input: PublishGenerativePresentationRequest
): Promise<GenerativePresentation> {
  const admitted = admitProducerMessages(input);
  const sourceData = readAuthorizedSource(context, input.source, admitted, input.actions);
  const dataModel = buildSourceDataModel(input.source, sourceData);
  const acceptedMessages = [
    input.messages[0],
    input.messages[1],
    {
      version: GENERATIVE_UI_PROTOCOL_VERSION,
      updateDataModel: {
        surfaceId: admitted.surfaceId,
        path: '/',
        value: dataModel,
      },
    },
  ];
  const acceptedBytes = Buffer.byteLength(JSON.stringify(acceptedMessages), 'utf8');
  if (acceptedBytes > ACCEPTED_MESSAGE_BYTE_LIMIT) {
    throw new KernelCommandError('limit_exceeded', 'Accepted A2UI messages exceed 2 MiB.', {
      limit: 'acceptedMessages',
      maximum: ACCEPTED_MESSAGE_BYTE_LIMIT,
    });
  }
  assertWritableTurn(context.store, context.workspaceId, input.threadId, input.turnId);
  const semanticInputHash = digestJson({
    threadId: input.threadId,
    turnId: input.turnId,
    title: input.title,
    fallbackText: input.fallbackText,
    messages: input.messages,
    source: input.source,
    actions: input.actions,
  });
  const presentationId = randomUUID();
  const itemId = `it_${randomUUID()}`;
  const createdAt = new Date().toISOString();
  const retained = await runIdempotentCommand({
    store: context.store,
    inflightCommands: context.inflightCommands,
    command: 'generative-ui.publish',
    requestId: context.requestId,
    scope: { workspaceId: context.workspaceId, actorId: actorScopeId(context.actor) },
    input: { actor: context.actor, ...input },
    responseKind: 'generative_presentation',
    workspaceDb: context.workspaceDb,
    workspaceTransaction: true,
    execute: () => {
      insertPresentation(context.workspaceDb, {
        presentation_id: presentationId,
        workspace_id: context.workspaceId,
        thread_id: input.threadId,
        turn_id: input.turnId,
        item_id: itemId,
        created_at: createdAt,
        actor_json: JSON.stringify(context.actor),
        request_id: context.requestId,
        origin_request_id: null,
        semantic_input_hash: semanticInputHash,
        title: input.title,
        fallback_text: input.fallbackText,
        protocol_version: GENERATIVE_UI_PROTOCOL_VERSION,
        catalog_id: GENERATIVE_UI_NATIVE_CATALOG_ID,
        messages_json: JSON.stringify(acceptedMessages),
        content_digest: digestJson(acceptedMessages),
        source_json: JSON.stringify(input.source),
        actions_json: JSON.stringify(input.actions),
        observed_at: createdAt,
      });
      recordWorkspaceAuditEvent({
        workspaceDb: context.workspaceDb,
        workspaceId: context.workspaceId,
        threadId: input.threadId,
        turnId: input.turnId,
        itemId,
        actor: context.actor,
        requestId: context.requestId,
        category: 'system',
        action: 'generative-ui.publish',
        resource: `generative-presentation:${presentationId}`,
        outcome: 'succeeded',
        summary: 'generative-ui.publish',
      });
      return presentationId;
    },
    replay: (record) => record.response.id,
    responseId: (id) => id,
  });
  const row = requirePresentationRow(context.workspaceDb, context.workspaceId, retained);
  appendPresentationItem(context.store, row);
  return projectPresentation(context.store, row);
}

/**
 * Reads one retained presentation.
 *
 * @param context Command context.
 * @param presentationId Presentation UUID.
 * @returns Presentation with derived publication.
 */
export function getGenerativePresentation(
  context: GenerativeUiCommandContext,
  presentationId: string
): GenerativePresentation {
  const row = requirePresentationRow(context.workspaceDb, context.workspaceId, presentationId);
  assertThreadReadable(context.store, context.workspaceId, row.thread_id);
  return projectPresentation(context.store, row);
}

/**
 * Returns the retained createSurface and updateComponents resource.
 *
 * @param context Command context.
 * @param presentationId Presentation UUID.
 * @returns A2UI resource body.
 */
export function getGenerativePresentationResource(
  context: GenerativeUiCommandContext,
  presentationId: string
): GenerativePresentationResourceResponse {
  const presentation = getGenerativePresentation(context, presentationId);
  return {
    uri: `ui://openkit/generative/${presentation.id}`,
    mimeType: 'application/a2ui+json',
    text: JSON.stringify(presentation.messages.slice(0, 2)),
  };
}

/**
 * Re-reads the current source without mutating business data.
 *
 * @param context Command context.
 * @param presentationId Presentation UUID.
 * @param event Native refresh event.
 * @returns Current data-model messages.
 */
export function refreshGenerativePresentation(
  context: GenerativeUiCommandContext,
  presentationId: string,
  event: GenerativeUiA2uiAction
): GenerativePresentationDataModelResponse {
  assertActionMessageSize(event);
  const presentation = getGenerativePresentation(context, presentationId);
  const action = requireAction(presentation, event, 'refresh');
  if (action.kind !== 'refresh') {
    throw new KernelCommandError('validation_failed', 'Refresh refuses mutating bindings.');
  }
  const admitted = admitProducerMessages({
    threadId: presentation.threadId,
    turnId: presentation.turnId,
    title: presentation.title,
    fallbackText: presentation.fallbackText,
    messages: presentation.messages.slice(0, 2),
    source: presentation.source,
    actions: presentation.actions,
  });
  const sourceData = readAuthorizedSource(
    context,
    presentation.source,
    admitted,
    presentation.actions
  );
  const observedAt = new Date().toISOString();
  return {
    presentationId: presentation.id,
    observedAt,
    messages: [
      {
        version: GENERATIVE_UI_PROTOCOL_VERSION,
        updateDataModel: {
          surfaceId: event.action.surfaceId,
          path: '/',
          value: buildSourceDataModel(presentation.source, sourceData),
        },
      },
    ],
  };
}

/**
 * Dispatches one admitted kernel-record-update action.
 *
 * @param context Command context.
 * @param presentationId Presentation UUID.
 * @param event Native update event.
 * @returns Current record plus data-model messages.
 */
export async function submitGenerativePresentationAction(
  context: GenerativeUiCommandContext,
  presentationId: string,
  event: GenerativeUiA2uiAction
): Promise<GenerativePresentationDataModelResponse> {
  assertActionMessageSize(event);
  const presentation = getGenerativePresentation(context, presentationId);
  const action = requireAction(presentation, event, 'kernel-record-update');
  if (action.kind !== 'kernel-record-update' || presentation.source.kind !== 'kernel-records') {
    throw new KernelCommandError('validation_failed', 'Action route refuses refresh bindings.');
  }
  const values = parseUpdateValues(context, event, action, presentation.source);
  const record = await updateRecord(
    context,
    presentation.source.appId,
    presentation.source.collectionId,
    action.recordId,
    {
      schemaRevision: presentation.source.schemaRevision,
      expectedRecordRevision: values.expectedRecordRevision,
      data: values.values,
    }
  );
  let refreshUnavailable = false;
  let messages: unknown[] = [];
  try {
    const listed = listRecords(
      context.dataRoot,
      context.workspaceId,
      presentation.source.appId,
      presentation.source.collectionId,
      {
        schemaRevision: presentation.source.schemaRevision,
        page: presentation.source.query.page,
        perPage: presentation.source.query.perPage,
        filter: presentation.source.query.filter,
        sort: presentation.source.query.sort,
        fields: presentation.source.query.fields,
      }
    );
    if (listed.items.length !== 1 || listed.items[0]?.id !== action.recordId) {
      refreshUnavailable = true;
    }
    messages = [
      {
        version: GENERATIVE_UI_PROTOCOL_VERSION,
        updateDataModel: {
          surfaceId: event.action.surfaceId,
          path: '/',
          value: {
            records: listed.items,
            schemaRevision: listed.schemaRevision,
          },
        },
      },
    ];
  } catch {
    refreshUnavailable = true;
    messages = [
      {
        version: GENERATIVE_UI_PROTOCOL_VERSION,
        updateDataModel: {
          surfaceId: event.action.surfaceId,
          path: '/',
          value: {
            records: [record],
            schemaRevision: record.schemaRevision,
          },
        },
      },
    ];
  }
  const response: GenerativePresentationDataModelResponse = {
    presentationId: presentation.id,
    observedAt: new Date().toISOString(),
    messages,
    record,
  };
  if (refreshUnavailable) {
    response.refreshUnavailable = true;
  }
  return response;
}

/**
 * Lists retained presentations for Workspace export.
 *
 * @param workspaceDb Workspace database.
 * @returns Portable presentation records.
 */
export function listExportableGenerativePresentations(workspaceDb: WorkspaceDb): unknown[] {
  return workspaceDb.sqlite
    .prepare(
      `SELECT * FROM generative_presentations
       WHERE workspace_id = ?
       ORDER BY created_at ASC, presentation_id ASC`
    )
    .all(workspaceDb.workspaceId)
    .map((row) => projectExportRow(row as PresentationRow));
}

function readAuthorizedSource(
  context: GenerativeUiCommandContext,
  source: PublishGenerativePresentationRequest['source'],
  admitted: AdmittedDeclaration,
  actions: readonly GenerativeUiAction[]
): { records?: LightAppRecord[]; text?: string; schemaRevision?: number } {
  if (source.kind === 'item') {
    return { text: readItemSource(context.store, context.workspaceId, source) };
  }
  const app = getLightApp(context.dataRoot, context.workspaceId, source.appId);
  if (app.lifecycle !== 'active' || !app.schema) {
    throw new KernelCommandError('unavailable', 'Light App source is unavailable.');
  }
  if (app.schema.schemaRevision !== source.schemaRevision) {
    throw new KernelCommandError('schema_stale', 'Kernel schema revision does not match the source.');
  }
  const collection = app.schema.collections.find((candidate) => candidate.id === source.collectionId);
  if (!collection) {
    throw new KernelCommandError('not_found', 'Source collection was not found.');
  }
  assertWriteForm(admitted, actions, source, collection.fields);
  const listed = listRecords(
    context.dataRoot,
    context.workspaceId,
    source.appId,
    source.collectionId,
    {
      schemaRevision: source.schemaRevision,
      page: source.query.page,
      perPage: source.query.perPage,
      filter: source.query.filter,
      sort: source.query.sort,
      fields: source.query.fields,
    }
  );
  const write = actions.find((candidate) => candidate.kind === 'kernel-record-update');
  if (write && write.kind === 'kernel-record-update') {
    if (listed.items.length !== 1 || listed.items[0]?.id !== write.recordId) {
      throw new KernelCommandError('unavailable', 'Bound record is not in the admitted source.');
    }
  }
  return { records: listed.items, schemaRevision: listed.schemaRevision };
}

function assertWriteForm(
  admitted: AdmittedDeclaration,
  actions: readonly GenerativeUiAction[],
  source: GenerativeUiKernelRecordsSource,
  fields: readonly LightAppAdmittedField[]
): void {
  const write = actions.find((candidate) => candidate.kind === 'kernel-record-update');
  if (!write || write.kind !== 'kernel-record-update') {
    return;
  }
  const writable = write.writableFieldIds.map((fieldId) => {
    const field = fields.find((candidate) => candidate.id === fieldId);
    if (!field || !field.required || (field.type !== 'text' && field.type !== 'bool')) {
      throw new KernelCommandError(
        'validation_failed',
        'Writable fields must be required text or bool fields.'
      );
    }
    return field;
  });
  const fieldNames = writable.map((field) => field.name);
  const queryFields = (source.query.fields ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (queryFields.join(',') !== fieldNames.join(',')) {
    throw new KernelCommandError(
      'validation_failed',
      'query.fields must equal the bound writable field names.'
    );
  }
  for (const field of writable) {
    const expectedType = field.type === 'text' ? 'TextField' : 'CheckBox';
    const expectedPath = `/records/0/data/${field.name}`;
    const controls = [...admitted.components.values()].filter((component) => {
      const value = field.type === 'text' ? component.props.text : component.props.value;
      return component.type === expectedType && bindingPath(value) === expectedPath;
    });
    if (controls.length !== 1) {
      throw new KernelCommandError(
        'validation_failed',
        `Field ${field.name} must have exactly one ${expectedType} bound to ${expectedPath}.`
      );
    }
  }
}

function readItemSource(
  store: FsStore,
  workspaceId: string,
  source: GenerativeUiItemSource
): string {
  const item = store
    .listWorkspaceItemRevisions(workspaceId)
    .find((candidate) => candidate.id === source.itemId);
  if (!item || item.workspaceId !== workspaceId) {
    throw new KernelCommandError('not_found', 'Source item was not found.');
  }
  if (item.type !== 'assistant-message' || item.status !== 'completed') {
    throw new KernelCommandError(
      'unsupported_operation',
      'Item sources must name a completed assistant-message.'
    );
  }
  const digest = digestText(item.text);
  if (digest !== source.contentDigest) {
    throw new KernelCommandError('conflict', 'Item content digest does not match the source.');
  }
  return item.text;
}

function buildSourceDataModel(
  source: PublishGenerativePresentationRequest['source'],
  data: { records?: LightAppRecord[]; text?: string; schemaRevision?: number }
): unknown {
  if (source.kind === 'item') {
    return { text: data.text ?? '' };
  }
  return { records: data.records ?? [], schemaRevision: data.schemaRevision };
}

function insertPresentation(workspaceDb: WorkspaceDb, row: PresentationRow): void {
  try {
    workspaceDb.sqlite
      .prepare(
        `INSERT INTO generative_presentations (
          presentation_id, workspace_id, thread_id, turn_id, item_id, created_at, actor_json,
          request_id, origin_request_id, semantic_input_hash, title, fallback_text, protocol_version,
          catalog_id, messages_json, content_digest, source_json, actions_json, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.presentation_id,
        row.workspace_id,
        row.thread_id,
        row.turn_id,
        row.item_id,
        row.created_at,
        row.actor_json,
        row.request_id,
        row.origin_request_id,
        row.semantic_input_hash,
        row.title,
        row.fallback_text,
        row.protocol_version,
        row.catalog_id,
        row.messages_json,
        row.content_digest,
        row.source_json,
        row.actions_json,
        row.observed_at
      );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('UNIQUE constraint failed')) {
      throw new KernelCommandError('conflict', 'Presentation request identity already exists.');
    }
    throw error;
  }
}

function requirePresentationRow(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  presentationId: string
): PresentationRow {
  const row = workspaceDb.sqlite
    .prepare(
      `SELECT * FROM generative_presentations WHERE workspace_id = ? AND presentation_id = ?`
    )
    .get(workspaceId, presentationId) as PresentationRow | undefined;
  if (!row) {
    throw new KernelCommandError('not_found', 'Presentation was not found.');
  }
  return row;
}

function appendPresentationItem(store: FsStore, row: PresentationRow): void {
  const existing = store
    .listWorkspaceItemRevisions(row.workspace_id)
    .find((item) => item.id === row.item_id);
  if (existing) {
    return;
  }
  const item: Item = {
    id: row.item_id,
    workspaceId: row.workspace_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    type: 'generative-ui-reference',
    status: 'completed',
    presentationId: row.presentation_id,
    title: row.title,
    fallbackText: row.fallback_text,
    createdAt: row.created_at,
    completedAt: row.created_at,
    causationId: row.request_id,
  };
  store.createItem(item);
}

function projectPresentation(store: FsStore, row: PresentationRow): GenerativePresentation {
  return {
    id: row.presentation_id,
    workspaceId: row.workspace_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    itemId: row.item_id,
    createdAt: row.created_at,
    actor: JSON.parse(row.actor_json) as ActorRef,
    requestId: row.request_id,
    originRequestId: row.origin_request_id,
    semanticInputHash: row.semantic_input_hash,
    title: row.title,
    fallbackText: row.fallback_text,
    protocolVersion: GENERATIVE_UI_PROTOCOL_VERSION,
    catalogId: GENERATIVE_UI_NATIVE_CATALOG_ID,
    messages: JSON.parse(row.messages_json) as unknown[],
    contentDigest: row.content_digest,
    source: JSON.parse(row.source_json) as GenerativePresentation['source'],
    actions: JSON.parse(row.actions_json) as GenerativeUiAction[],
    observedAt: row.observed_at,
    publication: derivePublication(store, row),
  };
}

function derivePublication(
  store: FsStore,
  row: PresentationRow
): GenerativePresentation['publication'] {
  const item = store
    .listWorkspaceItemRevisions(row.workspace_id)
    .find((candidate) => candidate.id === row.item_id);
  if (!item) {
    return 'unpublished';
  }
  if (
    item.type === 'generative-ui-reference' &&
    item.presentationId === row.presentation_id &&
    item.threadId === row.thread_id
  ) {
    return 'published';
  }
  return 'inconsistent';
}

function requireAction(
  presentation: GenerativePresentation,
  event: GenerativeUiA2uiAction,
  expectedKind: GenerativeUiAction['kind']
): GenerativeUiAction {
  const acceptedCreate = presentation.messages[0] as { createSurface?: { surfaceId?: string } };
  const surfaceId = acceptedCreate.createSurface?.surfaceId;
  if (event.action.surfaceId !== surfaceId) {
    throw new KernelCommandError(
      'validation_failed',
      'Action surface id does not match the presentation.'
    );
  }
  const action = presentation.actions.find((candidate) => candidate.name === event.action.name);
  if (!action || action.componentId !== event.action.sourceComponentId) {
    throw new KernelCommandError('validation_failed', 'Action is not bound on this presentation.');
  }
  if (action.kind !== expectedKind) {
    throw new KernelCommandError('validation_failed', `Expected a ${expectedKind} binding.`);
  }
  return action;
}

function parseUpdateValues(
  commandContext: GenerativeUiCommandContext,
  event: GenerativeUiA2uiAction,
  action: Extract<GenerativeUiAction, { kind: 'kernel-record-update' }>,
  source: GenerativeUiKernelRecordsSource
): { expectedRecordRevision: number; values: Record<string, string | boolean> } {
  const context = event.action.context ?? {};
  const keys = Object.keys(context);
  if (keys.length !== 2 || !('expectedRecordRevision' in context) || !('values' in context)) {
    throw new KernelCommandError(
      'validation_failed',
      'Record-update context must be exactly expectedRecordRevision and values.'
    );
  }
  const expectedRecordRevision = context.expectedRecordRevision;
  if (
    typeof expectedRecordRevision !== 'number' ||
    !Number.isInteger(expectedRecordRevision) ||
    expectedRecordRevision < 1
  ) {
    throw new KernelCommandError(
      'validation_failed',
      'expectedRecordRevision must be a positive integer.'
    );
  }
  const values = context.values;
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new KernelCommandError('validation_failed', 'values must be an object.');
  }
  const app = getLightApp(commandContext.dataRoot, commandContext.workspaceId, source.appId);
  const collection = app.schema?.collections.find((candidate) => candidate.id === source.collectionId);
  const allowed = new Set(
    action.writableFieldIds.map((fieldId) => {
      const field = collection?.fields.find((candidate) => candidate.id === fieldId);
      if (!field) {
        throw new KernelCommandError('validation_failed', 'Writable field is not in the admitted schema.');
      }
      return field.name;
    })
  );
  const submitted = values as Record<string, unknown>;
  const submittedKeys = Object.keys(submitted);
  if (submittedKeys.length === 0 || submittedKeys.some((key) => !allowed.has(key))) {
    throw new KernelCommandError(
      'validation_failed',
      'values must be a nonempty subset of bound fields.'
    );
  }
  for (const [key, value] of Object.entries(submitted)) {
    if (typeof value !== 'string' && typeof value !== 'boolean') {
      throw new KernelCommandError('validation_failed', `Value for ${key} must be text or bool.`);
    }
  }
  return {
    expectedRecordRevision,
    values: submitted as Record<string, string | boolean>,
  };
}

function assertWritableTurn(
  store: FsStore,
  workspaceId: string,
  threadId: string,
  turnId: string
): void {
  const thread = store.getThread(workspaceId, threadId);
  if (thread.status === 'archived') {
    throw new KernelCommandError('access_denied', 'Archived threads cannot receive presentations.');
  }
  const turn = store.getTurn(workspaceId, threadId, turnId);
  if (!WRITABLE_TURN_STATUSES.has(turn.status)) {
    throw new KernelCommandError('access_denied', 'Turn is not writable for publication.');
  }
}

function assertThreadReadable(store: FsStore, workspaceId: string, threadId: string): void {
  store.getThread(workspaceId, threadId);
}

function assertActionMessageSize(event: GenerativeUiA2uiAction): void {
  if (Buffer.byteLength(JSON.stringify(event), 'utf8') > ACTION_MESSAGE_BYTE_LIMIT) {
    throw new KernelCommandError('limit_exceeded', 'Action message exceeds 64 KiB.', {
      limit: 'actionMessage',
      maximum: ACTION_MESSAGE_BYTE_LIMIT,
    });
  }
}

function projectExportRow(row: PresentationRow): Record<string, unknown> {
  return {
    schemaVersion: 1,
    recordType: 'generative-presentation',
    id: row.presentation_id,
    ownerScope: 'workspace',
    lineage: {
      workspaceId: row.workspace_id,
      threadId: row.thread_id,
      turnId: row.turn_id,
      itemId: row.item_id,
      requestId: row.request_id,
    },
    createdAt: row.created_at,
    updatedAt: row.created_at,
    contentDigest: row.content_digest,
    presentation: {
      actor: JSON.parse(row.actor_json),
      requestId: row.request_id,
      originRequestId: row.origin_request_id,
      semanticInputHash: row.semantic_input_hash,
      title: row.title,
      fallbackText: row.fallback_text,
      protocolVersion: row.protocol_version,
      catalogId: row.catalog_id,
      messages: JSON.parse(row.messages_json),
      source: JSON.parse(row.source_json),
      actions: JSON.parse(row.actions_json),
      observedAt: row.observed_at,
    },
  };
}

function digestJson(value: unknown): string {
  return digestText(JSON.stringify(value));
}

function digestText(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function actorScopeId(actor: ActorRef): string {
  return actor.kind === 'user' ? actor.id : `${actor.kind}:${actor.id}`;
}
