import { createHash, randomUUID } from 'node:crypto';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import type { ActorRef } from '@openkit/protocol';

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
    inputSchema: { type: 'object', additionalProperties: true },
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
    inputSchema: { type: 'object', additionalProperties: true, required: ['appId'] },
  },
  {
    name: 'kernel_apps_retire',
    description: 'Retire one Light App and disable writes.',
    inputSchema: { type: 'object', additionalProperties: true, required: ['appId'] },
  },
  {
    name: 'kernel_records_list',
    description: 'List records in one Light App collection.',
    inputSchema: { type: 'object', additionalProperties: true, required: ['appId', 'collection'] },
  },
  {
    name: 'kernel_records_get',
    description: 'Read one Light App record.',
    inputSchema: {
      type: 'object',
      additionalProperties: true,
      required: ['appId', 'collection', 'recordId'],
    },
  },
  {
    name: 'kernel_records_create',
    description: 'Create one Light App record.',
    inputSchema: { type: 'object', additionalProperties: true, required: ['appId', 'collection'] },
  },
  {
    name: 'kernel_records_update',
    description: 'Update one Light App record.',
    inputSchema: {
      type: 'object',
      additionalProperties: true,
      required: ['appId', 'collection', 'recordId'],
    },
  },
  {
    name: 'kernel_records_batch',
    description: 'Apply one atomic Light App record batch.',
    inputSchema: { type: 'object', additionalProperties: true, required: ['appId'] },
  },
  {
    name: 'generative_ui_publish',
    description: 'Publish one admitted native Generative UI presentation.',
    inputSchema: { type: 'object', additionalProperties: true },
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
    inputSchema: { type: 'object', additionalProperties: true, required: ['presentationId'] },
  },
  {
    name: 'generative_ui_action',
    description: 'Submit one admitted Kernel record-update action.',
    inputSchema: { type: 'object', additionalProperties: true, required: ['presentationId'] },
  },
] as const;

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
): Promise<{ content: Array<{ type: 'text'; text: string }>; structuredContent: unknown; _meta?: Record<string, unknown> }> {
  assertScope(args, context);
  const kernelContext = {
    store: context.store,
    inflightCommands: context.inflightCommands,
    dataRoot: context.dataRoot,
    workspaceId: context.workspaceId,
    actor: context.actor,
    requestId: requestIdFrom(args),
  };
  const uiContext = { ...kernelContext, workspaceDb: context.workspaceDb };
  switch (toolName) {
    case 'kernel_apps_list':
      return textResult(listLightApps(context.dataRoot, context.workspaceId));
    case 'kernel_apps_create':
      return textResult(await createLightApp(kernelContext, schemaArg(args)));
    case 'kernel_apps_get':
      return textResult(getLightApp(context.dataRoot, context.workspaceId, stringArg(args, 'appId')));
    case 'kernel_schema_update':
      return textResult(
        await updateLightAppSchema(
          kernelContext,
          stringArg(args, 'appId'),
          numberArg(args, 'expectedAppRevision'),
          numberArg(args, 'expectedSchemaRevision'),
          args.schema as never
        )
      );
    case 'kernel_apps_retire':
      return textResult(
        await retireLightApp(kernelContext, stringArg(args, 'appId'), numberArg(args, 'expectedAppRevision'))
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
    case 'kernel_records_create':
      return textResult(
        await createRecord(
          kernelContext,
          stringArg(args, 'appId'),
          stringArg(args, 'collection'),
          numberArg(args, 'schemaRevision'),
          asRecord(args.data)
        )
      );
    case 'kernel_records_update':
      return textResult(
        await updateRecord(
          kernelContext,
          stringArg(args, 'appId'),
          stringArg(args, 'collection'),
          stringArg(args, 'recordId'),
          {
            schemaRevision: numberArg(args, 'schemaRevision'),
            expectedRecordRevision: numberArg(args, 'expectedRecordRevision'),
            data: asRecord(args.data),
          }
        )
      );
    case 'kernel_records_batch':
      return textResult(await batchRecords(kernelContext, stringArg(args, 'appId'), args as never));
    case 'generative_ui_publish': {
      const published = await publishGenerativePresentation(uiContext, args as never);
      return {
        content: [{ type: 'text', text: published.fallbackText }],
        structuredContent: published,
        _meta: { ui: { resourceUri: `ui://openkit/generative/${published.id}` } },
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
          actionEvent(args)
        )
      );
    case 'generative_ui_action':
      return textResult(
        await submitGenerativePresentationAction(
          uiContext,
          stringArg(args, 'presentationId'),
          actionEvent(args)
        )
      );
    default:
      throw new KernelCommandError('unsupported_operation', `Unknown generative tool: ${toolName}.`);
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
    throw new KernelCommandError('access_denied', 'Tool workspaceId does not match the Worker session.');
  }
  if (typeof args.threadId === 'string' && args.threadId !== context.scope.threadId) {
    throw new KernelCommandError('access_denied', 'Tool threadId does not match the Worker session.');
  }
  if (typeof args.turnId === 'string' && args.turnId !== context.scope.turnId) {
    throw new KernelCommandError('access_denied', 'Tool turnId does not match the Worker session.');
  }
}

function requestIdFrom(args: Record<string, unknown>): string {
  return typeof args.requestId === 'string' && args.requestId.length > 0
    ? args.requestId
    : randomUUID();
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

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new KernelCommandError('validation_failed', 'Expected an object.');
  }
  return value as Record<string, unknown>;
}

function schemaArg(args: Record<string, unknown>): never {
  if (args.schema && typeof args.schema === 'object' && !Array.isArray(args.schema)) {
    return args.schema as never;
  }
  const schema = { ...args };
  delete schema.workspaceId;
  delete schema.threadId;
  delete schema.turnId;
  delete schema.requestId;
  delete schema.agentSessionId;
  return schema as never;
}

function actionEvent(args: Record<string, unknown>): never {
  if (args.event && typeof args.event === 'object') {
    return args.event as never;
  }
  const event = { ...args };
  delete event.presentationId;
  delete event.requestId;
  delete event.workspaceId;
  delete event.threadId;
  delete event.turnId;
  return event as never;
}
