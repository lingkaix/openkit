import { createHash } from 'node:crypto';
import {
  CreateLightAppRecordRequestSchema,
  CreateLightAppRequestSchema,
  GenerativeUiA2uiActionSchema,
  LightAppBatchRequestSchema,
  PublishGenerativePresentationRequestSchema,
  UpdateLightAppRecordRequestSchema,
  UpdateLightAppSchemaRequestSchema,
} from '@openkit/app-api-schemas';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import { type ActorRef, RequestIdSchema } from '@openkit/protocol';
import type { z } from 'zod';

import {
  batchRecords,
  createLightApp,
  createRecord,
  getLightApp,
  getRecord,
  listLightApps,
  listRecords,
  retireLightApp,
  updateLightAppSchema,
  updateRecord,
} from '../generative-kernel/commands.js';
import { KernelCommandError } from '../generative-kernel/errors.js';
import {
  getGenerativePresentation,
  getGenerativePresentationResource,
  publishGenerativePresentation,
  refreshGenerativePresentation,
  submitGenerativePresentationAction,
} from '../generative-ui/commands.js';
import type { FsStore } from '../lib/store.js';
import type { InflightIdempotentCommand } from '../runtime/idempotent-command.js';
import type { WorkspaceDb } from '../storage/db.js';

/** Reserved built-in Worker MCP server id. */
export const OPENKIT_GENERATIVE_MCP_ID = 'openkit-generative';

/** Built-in tool descriptors used for ListTools and catalog digest. */
export const OPENKIT_GENERATIVE_TOOLS = [
  {
    name: 'kernel_apps_list',
    description: 'List Light Apps in the current Workspace.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'kernel_apps_create',
    description: 'Create one Light App from a file-authored schema.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['format', 'schemaVersion', 'title', 'purpose', 'collections'],
      properties: {
        format: { type: 'string' },
        schemaVersion: { type: 'integer' },
        title: { type: 'string' },
        purpose: { type: 'string' },
        collections: { type: 'array' },
      },
    },
  },
  {
    name: 'kernel_apps_get',
    description: 'Read one Light App schema and capabilities.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['appId'],
      properties: { appId: { type: 'string', format: 'uuid' } },
    },
  },
  {
    name: 'kernel_schema_update',
    description: 'Update one Light App schema within the initial evolution ceiling.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['appId', 'expectedAppRevision', 'expectedSchemaRevision', 'schema'],
      properties: {
        appId: { type: 'string', format: 'uuid' },
        expectedAppRevision: { type: 'integer' },
        expectedSchemaRevision: { type: 'integer' },
        schema: { type: 'object' },
      },
    },
  },
  {
    name: 'kernel_apps_retire',
    description: 'Retire one Light App and disable writes.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['appId', 'expectedAppRevision'],
      properties: {
        appId: { type: 'string', format: 'uuid' },
        expectedAppRevision: { type: 'integer' },
      },
    },
  },
  {
    name: 'kernel_records_list',
    description: 'List records in one Light App collection.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['appId', 'collection', 'schemaRevision'],
      properties: {
        appId: { type: 'string', format: 'uuid' },
        collection: { type: 'string' },
        schemaRevision: { type: 'integer' },
        page: { type: 'integer' },
        perPage: { type: 'integer' },
        filter: { type: 'string' },
        sort: { type: 'string' },
        fields: { type: 'string' },
      },
    },
  },
  {
    name: 'kernel_records_get',
    description: 'Read one Light App record.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['appId', 'collection', 'recordId', 'schemaRevision'],
      properties: {
        appId: { type: 'string', format: 'uuid' },
        collection: { type: 'string' },
        recordId: { type: 'string', format: 'uuid' },
        schemaRevision: { type: 'integer' },
        fields: { type: 'string' },
      },
    },
  },
  {
    name: 'kernel_records_create',
    description: 'Create one Light App record.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['appId', 'collection', 'schemaRevision', 'data'],
      properties: {
        appId: { type: 'string', format: 'uuid' },
        collection: { type: 'string' },
        schemaRevision: { type: 'integer' },
        data: { type: 'object' },
      },
    },
  },
  {
    name: 'kernel_records_update',
    description: 'Update one Light App record.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: [
        'appId',
        'collection',
        'recordId',
        'schemaRevision',
        'expectedRecordRevision',
        'data',
      ],
      properties: {
        appId: { type: 'string', format: 'uuid' },
        collection: { type: 'string' },
        recordId: { type: 'string', format: 'uuid' },
        schemaRevision: { type: 'integer' },
        expectedRecordRevision: { type: 'integer' },
        data: { type: 'object' },
      },
    },
  },
  {
    name: 'kernel_records_batch',
    description: 'Apply one atomic Light App record batch.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['appId', 'schemaRevision', 'requests'],
      properties: {
        appId: { type: 'string', format: 'uuid' },
        schemaRevision: { type: 'integer' },
        requests: { type: 'array', maxItems: 50 },
      },
    },
  },
  {
    name: 'generative_ui_publish',
    description: 'Publish one admitted native Generative UI presentation.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['threadId', 'turnId', 'title', 'fallbackText', 'messages', 'source', 'actions'],
      properties: {
        threadId: { type: 'string' },
        turnId: { type: 'string' },
        title: { type: 'string' },
        fallbackText: { type: 'string' },
        messages: { type: 'array' },
        source: { type: 'object' },
        actions: { type: 'array' },
      },
    },
  },
  {
    name: 'generative_ui_get',
    description: 'Read one retained Generative UI presentation.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['presentationId'],
      properties: { presentationId: { type: 'string', format: 'uuid' } },
    },
  },
  {
    name: 'generative_ui_resource',
    description: 'Read the retained native A2UI resource for one presentation.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['presentationId'],
      properties: { presentationId: { type: 'string', format: 'uuid' } },
    },
  },
  {
    name: 'generative_ui_refresh',
    description: 'Refresh one presentation from its current authorized source.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['presentationId', 'version', 'action'],
      properties: {
        presentationId: { type: 'string', format: 'uuid' },
        version: { type: 'string' },
        action: { type: 'object' },
      },
    },
  },
  {
    name: 'generative_ui_action',
    description: 'Submit one admitted Kernel record-update action.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['presentationId', 'version', 'action'],
      properties: {
        presentationId: { type: 'string', format: 'uuid' },
        version: { type: 'string' },
        action: { type: 'object' },
      },
    },
  },
] as const;

/** App API operations authorized for each built-in generative tool. */
export const OPENKIT_GENERATIVE_TOOL_OPERATIONS = {
  kernel_apps_list: 'listLightApps',
  kernel_apps_create: 'createLightApp',
  kernel_apps_get: 'getLightApp',
  kernel_schema_update: 'updateLightAppSchema',
  kernel_apps_retire: 'retireLightApp',
  kernel_records_list: 'listLightAppRecords',
  kernel_records_get: 'getLightAppRecord',
  kernel_records_create: 'createLightAppRecord',
  kernel_records_update: 'updateLightAppRecord',
  kernel_records_batch: 'batchLightAppRecords',
  generative_ui_publish: 'publishGenerativePresentation',
  generative_ui_get: 'getGenerativePresentation',
  generative_ui_resource: 'getGenerativePresentationResource',
  generative_ui_refresh: 'refreshGenerativePresentation',
  generative_ui_action: 'submitGenerativePresentationAction',
} as const;

/** SHA-256 digest of the built-in tool-schema descriptor. */
export const OPENKIT_GENERATIVE_CATALOG_DIGEST = `sha256:${createHash('sha256')
  .update(JSON.stringify(OPENKIT_GENERATIVE_TOOLS))
  .digest('hex')}`;

/**
 * Builds the built-in MCP supply entry for a Worker environment package.
 *
 * @returns Catalog-compatible supply entry.
 */
export function createOpenkitGenerativeMcpSupply(): AgentEnvironmentPackage['supply']['mcpServers'][number] {
  return {
    id: OPENKIT_GENERATIVE_MCP_ID,
    catalogDigest: OPENKIT_GENERATIVE_CATALOG_DIGEST,
    allowedTools: OPENKIT_GENERATIVE_TOOLS.map((tool) => tool.name),
    deniedTools: [],
    approvalRequiredTools: [],
    schemaPolicy: 'pinned',
    pinnedSchemaSnapshotId: null,
  };
}

/** In-process built-in MCP dispatch context. */
export interface OpenkitGenerativeMcpContext {
  /** Store that owns Thread/Turn/Item history. */
  readonly store: FsStore;
  /** In-flight command map. */
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  /** Data root. */
  readonly dataRoot: string;
  /** Authenticated Workspace. */
  readonly workspaceId: string;
  /** Trusted actor. */
  readonly actor: ActorRef;
  /** Open Workspace database. */
  readonly workspaceDb: WorkspaceDb;
  /** Authenticated environment scope. */
  readonly scope: AgentEnvironmentPackage['scope'];
  /** MCP protocol request identity used to stabilize Kernel request ids. */
  readonly protocolRequestId?: string | number;
}

/**
 * Dispatches one built-in openkit-generative tool in process.
 *
 * @param context Dispatch context.
 * @param toolName Tool name.
 * @param args Tool arguments.
 * @returns Structured tool result.
 */
export async function dispatchOpenkitGenerativeTool(
  context: OpenkitGenerativeMcpContext,
  toolName: string,
  args: Record<string, unknown>
): Promise<{
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'resource'; resource: { uri: string; mimeType: string; text: string } }
  >;
  structuredContent: unknown;
  _meta?: Record<string, unknown>;
}> {
  assertScope(args, context);
  const kernelContext = {
    store: context.store,
    inflightCommands: context.inflightCommands,
    dataRoot: context.dataRoot,
    workspaceId: context.workspaceId,
    actor: context.actor,
    requestId: requestIdFrom(args, context),
  };
  const uiContext = { ...kernelContext, workspaceDb: context.workspaceDb };
  switch (toolName) {
    case 'kernel_apps_list':
      return textResult(listLightApps(context.dataRoot, context.workspaceId));
    case 'kernel_apps_create':
      return textResult(
        await createLightApp(
          kernelContext,
          parseTool(CreateLightAppRequestSchema, withoutScope(args))
        )
      );
    case 'kernel_apps_get':
      return textResult(
        getLightApp(context.dataRoot, context.workspaceId, stringArg(args, 'appId'))
      );
    case 'kernel_schema_update': {
      const body = parseTool(UpdateLightAppSchemaRequestSchema, {
        expectedAppRevision: args.expectedAppRevision,
        expectedSchemaRevision: args.expectedSchemaRevision,
        schema: args.schema,
      });
      return textResult(
        await updateLightAppSchema(
          kernelContext,
          stringArg(args, 'appId'),
          body.expectedAppRevision,
          body.expectedSchemaRevision,
          body.schema
        )
      );
    }
    case 'kernel_apps_retire':
      return textResult(
        await retireLightApp(
          kernelContext,
          stringArg(args, 'appId'),
          numberArg(args, 'expectedAppRevision')
        )
      );
    case 'kernel_records_list':
      return textResult(
        listRecords(
          context.dataRoot,
          context.workspaceId,
          stringArg(args, 'appId'),
          stringArg(args, 'collection'),
          {
            schemaRevision: numberArg(args, 'schemaRevision'),
            page: optionalNumber(args.page),
            perPage: optionalNumber(args.perPage),
            filter: optionalString(args.filter),
            sort: optionalString(args.sort),
            fields: optionalString(args.fields),
          }
        )
      );
    case 'kernel_records_get':
      return textResult(
        getRecord(
          context.dataRoot,
          context.workspaceId,
          stringArg(args, 'appId'),
          stringArg(args, 'collection'),
          stringArg(args, 'recordId'),
          numberArg(args, 'schemaRevision'),
          optionalString(args.fields)
        )
      );
    case 'kernel_records_create': {
      const body = parseTool(CreateLightAppRecordRequestSchema, {
        schemaRevision: args.schemaRevision,
        data: args.data,
      });
      return textResult(
        await createRecord(
          kernelContext,
          stringArg(args, 'appId'),
          stringArg(args, 'collection'),
          body.schemaRevision,
          body.data
        )
      );
    }
    case 'kernel_records_update': {
      const body = parseTool(UpdateLightAppRecordRequestSchema, {
        schemaRevision: args.schemaRevision,
        expectedRecordRevision: args.expectedRecordRevision,
        data: args.data,
      });
      return textResult(
        await updateRecord(
          kernelContext,
          stringArg(args, 'appId'),
          stringArg(args, 'collection'),
          stringArg(args, 'recordId'),
          body
        )
      );
    }
    case 'kernel_records_batch': {
      const body = parseTool(LightAppBatchRequestSchema, {
        schemaRevision: args.schemaRevision,
        requests: args.requests,
      });
      return textResult(await batchRecords(kernelContext, stringArg(args, 'appId'), body));
    }
    case 'generative_ui_publish': {
      const published = await publishGenerativePresentation(
        uiContext,
        parseTool(PublishGenerativePresentationRequestSchema, withoutScope(args))
      );
      const resource = getGenerativePresentationResource(uiContext, published.id);
      return {
        content: [
          { type: 'text', text: published.fallbackText },
          {
            type: 'resource',
            resource: {
              uri: resource.uri,
              mimeType: resource.mimeType,
              text: resource.text,
            },
          },
        ],
        structuredContent: published,
        _meta: { ui: { resourceUri: resource.uri } },
      };
    }
    case 'generative_ui_get':
      return textResult(getGenerativePresentation(uiContext, stringArg(args, 'presentationId')));
    case 'generative_ui_resource':
      return textResult(
        getGenerativePresentationResource(uiContext, stringArg(args, 'presentationId'))
      );
    case 'generative_ui_refresh':
      return textResult(
        refreshGenerativePresentation(
          uiContext,
          stringArg(args, 'presentationId'),
          parseTool(GenerativeUiA2uiActionSchema, actionBody(args))
        )
      );
    case 'generative_ui_action':
      return textResult(
        await submitGenerativePresentationAction(
          uiContext,
          stringArg(args, 'presentationId'),
          parseTool(GenerativeUiA2uiActionSchema, actionBody(args))
        )
      );
    default:
      throw new KernelCommandError(
        'unsupported_operation',
        `Unknown generative tool: ${toolName}.`
      );
  }
}

function textResult(value: unknown): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: unknown;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function assertScope(args: Record<string, unknown>, context: OpenkitGenerativeMcpContext): void {
  if (typeof args.workspaceId === 'string' && args.workspaceId !== context.workspaceId) {
    throw new KernelCommandError(
      'access_denied',
      'Tool workspaceId does not match the Worker session.'
    );
  }
  if (typeof args.threadId === 'string' && args.threadId !== context.scope.threadId) {
    throw new KernelCommandError(
      'access_denied',
      'Tool threadId does not match the Worker session.'
    );
  }
  if (typeof args.turnId === 'string' && args.turnId !== context.scope.turnId) {
    throw new KernelCommandError('access_denied', 'Tool turnId does not match the Worker session.');
  }
  if (
    typeof args.agentSessionId === 'string' &&
    args.agentSessionId !== context.scope.agentSessionId
  ) {
    throw new KernelCommandError(
      'access_denied',
      'Tool agentSessionId does not match the Worker session.'
    );
  }
}

function requestIdFrom(
  args: Record<string, unknown>,
  context: OpenkitGenerativeMcpContext
): string {
  if (args.requestId !== undefined) {
    const parsed = RequestIdSchema.safeParse(args.requestId);
    if (!parsed.success) {
      throw new KernelCommandError('validation_failed', 'requestId must be a UUID.');
    }
    return parsed.data;
  }
  if (typeof context.protocolRequestId === 'string') {
    const parsed = RequestIdSchema.safeParse(context.protocolRequestId);
    if (parsed.success) {
      return parsed.data;
    }
  }
  const seed = `${context.workspaceId}:${context.scope.turnId}:${String(context.protocolRequestId ?? '')}`;
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function withoutScope(args: Record<string, unknown>): Record<string, unknown> {
  const {
    workspaceId: _workspaceId,
    threadId: _threadId,
    turnId: _turnId,
    requestId: _requestId,
    agentSessionId: _agentSessionId,
    ...rest
  } = args;
  return rest;
}

function actionBody(args: Record<string, unknown>): unknown {
  if (args.event && typeof args.event === 'object') {
    return args.event;
  }
  const rest = withoutScope(args);
  delete rest.presentationId;
  return rest;
}

function parseTool<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new KernelCommandError(
      'validation_failed',
      parsed.error.issues[0]?.message ?? 'Invalid tool arguments.'
    );
  }
  return parsed.data;
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new KernelCommandError('validation_failed', `${key} is required.`);
  }
  return value;
}

function numberArg(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new KernelCommandError('validation_failed', `${key} must be an integer.`);
  }
  return value;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
