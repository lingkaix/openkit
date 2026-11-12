import {
  type GOVERNANCE_OPERATION_DEFINITIONS,
  TimelineEvidenceFilterSchema,
} from '@openkit/app-api-schemas';
import {
  type AuditEvent,
  AuditEventIdSchema,
  CapabilityCallIdSchema,
  compareCodeUnits,
  PermissionDecisionIdSchema,
  UsageRecordIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import { listServerAuditEvents, listWorkspaceAuditEvents } from './audit-events.js';
import { isCurrentDeploymentAdministrator } from './auth/operation-authorizer.js';
import { isThreadIdVisible } from './auth/thread-visibility.js';
import {
  listWorkspaceCapabilityCalls,
  listWorkspaceUsageRecords,
} from './capability/usage-ledger.js';
import { listWorkspaceEvidenceBundles } from './evidence-bundles.js';
import { StoreRecordNotFoundError } from './lib/store.js';
import type { OperationInvocationDependencies } from './operation-composition.js';
import { type FamilyImplementations, publicOperationActor } from './operation-contract.js';
import { OperationError } from './operation-error.js';
import {
  listExportableWorkspacePermissionDecisions,
  listServerPermissionDecisions,
} from './policy/permission-decisions.js';
import { listWorkspaceRuntimeEvidence } from './runtime/runtime-evidence.js';

/** Joins governance reads to their retained ledger owners without a second record lifecycle. */
export function createGovernanceOperationImplementations(
  dependencies: Pick<OperationInvocationDependencies, 'coreDb' | 'repositoryWorkspaceDb' | 'store'>
) {
  const { coreDb, repositoryWorkspaceDb } = dependencies;
  return {
    'usage.read': (input, context) => {
      try {
        const workspaceId = input.workspaceId;
        const workspaceDb = repositoryWorkspaceDb!(workspaceId);

        try {
          const position = decodeUsageReadCursor(input.cursor, workspaceId);
          const filters = selectTimelineEvidenceFilter(input, position?.filters);
          const visibleCalls = listWorkspaceCapabilityCalls(workspaceDb, workspaceId)
            .filter((call) => matchesTimelineEvidence(call, filters, call.id))
            .filter(
              (call) =>
                !call.threadId ||
                isThreadIdVisible(
                  dependencies.store!,
                  workspaceId,
                  call.threadId,
                  publicOperationActor(context).userId,
                  isCurrentDeploymentAdministrator(coreDb!, publicOperationActor(context))
                )
            )
            .map((call) => {
              const { extensions, ...projection } = call;
              const lineage = extensions?.['openkit.gateway/routeLineage'];
              return {
                ...projection,
                ...(lineage
                  ? {
                      routeLineage: {
                        logicalModelId: lineage.logicalModelId,
                        entries: lineage.entries.map((entry) => {
                          const common = {
                            routeMemberId: entry.routeMemberId,
                            selectionReason: entry.selectionReason,
                            ...(entry.failureKind ? { failureKind: entry.failureKind } : {}),
                          };
                          return entry.kind === 'attempt'
                            ? {
                                ...common,
                                kind: entry.kind,
                                attemptOrder: entry.attemptOrder,
                                retryIndex: entry.retryIndex,
                                outputBegan: entry.outputBegan,
                                terminalResult: entry.terminalResult,
                                released: entry.outputBegan,
                              }
                            : { ...common, kind: entry.kind };
                        }),
                      },
                    }
                  : {}),
              };
            });
          const visibleUsage = listWorkspaceUsageRecords(workspaceDb, workspaceId)
            .filter((usage) => matchesTimelineEvidence(usage, filters))
            .filter(
              (usage) =>
                !usage.threadId ||
                isThreadIdVisible(
                  dependencies.store!,
                  workspaceId,
                  usage.threadId,
                  publicOperationActor(context).userId,
                  isCurrentDeploymentAdministrator(coreDb!, publicOperationActor(context))
                )
            );
          const remainingCalls = !position
            ? visibleCalls
            : position.call === null
              ? []
              : visibleCalls.filter(
                  (call) =>
                    (compareCodeUnits(call.startedAt ?? '', position.call![0]) ||
                      compareCodeUnits(call.id, position.call![1])) > 0
                );
          const remainingUsage = !position
            ? visibleUsage
            : position.usage === null
              ? []
              : visibleUsage.filter(
                  (usage) =>
                    (compareCodeUnits(usage.recordedAt, position.usage![0]) ||
                      compareCodeUnits(usage.id, position.usage![1])) > 0
                );
          const capabilityCalls =
            input.limit === undefined ? remainingCalls : remainingCalls.slice(0, input.limit);
          const usageRecords =
            input.limit === undefined ? remainingUsage : remainingUsage.slice(0, input.limit);
          const hasMoreCalls = capabilityCalls.length < remainingCalls.length;
          const hasMoreUsage = usageRecords.length < remainingUsage.length;
          return {
            workspaceId,
            capabilityCalls,
            usageRecords,
            nextCursor:
              hasMoreCalls || hasMoreUsage
                ? Buffer.from(
                    JSON.stringify([
                      'usage.read',
                      workspaceId,
                      filters,
                      hasMoreCalls
                        ? [capabilityCalls.at(-1)!.startedAt ?? '', capabilityCalls.at(-1)!.id]
                        : null,
                      hasMoreUsage
                        ? [usageRecords.at(-1)!.recordedAt, usageRecords.at(-1)!.id]
                        : null,
                    ])
                  ).toString('base64url')
                : null,
          };
        } finally {
          workspaceDb.sqlite.close();
        }
      } catch (error) {
        governanceReadFailure(error);
      }
    },
    'audit.workspace-list': (input, context) => {
      try {
        const workspaceId = input.workspaceId;
        const workspaceDb = repositoryWorkspaceDb!(workspaceId);

        try {
          const position = decodeWorkspaceAuditCursor(input.cursor, workspaceId);
          const filters = selectTimelineEvidenceFilter(input, position?.filters);
          const visibleEvents = listWorkspaceAuditEvents(workspaceDb, workspaceId, coreDb)
            .filter((event) => matchesTimelineEvidence(event, filters))
            .filter(
              (event) =>
                !event.threadId ||
                isThreadIdVisible(
                  dependencies.store!,
                  workspaceId,
                  event.threadId,
                  publicOperationActor(context).userId,
                  isCurrentDeploymentAdministrator(coreDb!, publicOperationActor(context))
                )
            );
          const remaining = visibleEvents
            .sort(compareWorkspaceAuditPositions)
            .filter((event) => !position || compareWorkspaceAuditPositions(event, position) > 0);
          const auditEvents =
            input.limit === undefined ? remaining : remaining.slice(0, input.limit);
          const last = auditEvents.at(-1);
          return {
            workspaceId,
            auditEvents,
            nextCursor:
              last && auditEvents.length < remaining.length
                ? Buffer.from(
                    JSON.stringify([
                      'audit.workspace-list',
                      workspaceId,
                      filters,
                      last.createdAt ?? '',
                      last.id,
                    ])
                  ).toString('base64url')
                : null,
          };
        } finally {
          workspaceDb.sqlite.close();
        }
      } catch (error) {
        governanceReadFailure(error);
      }
    },
    'audit.server-list': (input) => {
      try {
        if (!coreDb) {
          throw new OperationError(
            'server_audit_storage_unavailable',
            'Server audit storage is unavailable for this NanoCore instance.',
            503
          );
        }

        const position = decodeServerAuditCursor(input.cursor);
        const filters = selectTimelineEvidenceFilter(input, position?.filters);
        const remaining = listServerAuditEvents(coreDb)
          .filter((event) => matchesTimelineEvidence(event, filters))
          .sort(compareWorkspaceAuditPositions)
          .filter((event) => !position || compareWorkspaceAuditPositions(event, position) > 0);
        const auditEvents = input.limit === undefined ? remaining : remaining.slice(0, input.limit);
        const last = auditEvents.at(-1);
        return {
          auditEvents,
          nextCursor:
            last && auditEvents.length < remaining.length
              ? Buffer.from(
                  JSON.stringify(['audit.server-list', filters, last.createdAt ?? '', last.id])
                ).toString('base64url')
              : null,
        };
      } catch (error) {
        governanceReadFailure(error);
      }
    },
    'evidence.bundle-list': (input) => {
      try {
        const workspaceId = input.workspaceId;
        const workspaceDb = repositoryWorkspaceDb!(workspaceId);

        try {
          return {
            workspaceId,
            evidenceBundles: listWorkspaceEvidenceBundles(workspaceDb, workspaceId),
          };
        } finally {
          workspaceDb.sqlite.close();
        }
      } catch (error) {
        governanceReadFailure(error);
      }
    },
    'evidence.runtime-list': (input) => {
      try {
        const workspaceId = input.workspaceId;
        const workspaceDb = repositoryWorkspaceDb!(workspaceId);

        try {
          return {
            workspaceId,
            runtimeEvidence: listWorkspaceRuntimeEvidence(workspaceDb, workspaceId),
          };
        } finally {
          workspaceDb.sqlite.close();
        }
      } catch (error) {
        governanceReadFailure(error);
      }
    },
    'permission.workspace-list': (input) => {
      try {
        const workspaceId = input.workspaceId;
        const workspaceDb = repositoryWorkspaceDb!(workspaceId);

        try {
          const position = decodeWorkspacePermissionCursor(input.cursor, workspaceId);
          const remaining = listExportableWorkspacePermissionDecisions(workspaceDb, workspaceId)
            .sort(comparePermissionDecisionPositions)
            .filter(
              (decision) => !position || comparePermissionDecisionPositions(decision, position) > 0
            );
          const permissionDecisions =
            input.limit === undefined ? remaining : remaining.slice(0, input.limit);
          const last = permissionDecisions.at(-1);
          return {
            workspaceId,
            permissionDecisions,
            nextCursor:
              last && permissionDecisions.length < remaining.length
                ? Buffer.from(
                    JSON.stringify([
                      'permission.workspace-list',
                      workspaceId,
                      last.createdAt,
                      last.decisionId,
                    ])
                  ).toString('base64url')
                : null,
          };
        } finally {
          workspaceDb.sqlite.close();
        }
      } catch (error) {
        governanceReadFailure(error);
      }
    },
    'permission.server-list': (input) => {
      try {
        if (!coreDb) {
          throw new OperationError('not_found', 'Core DB is not available.', 404);
        }

        const position = decodeServerPermissionCursor(input.cursor);
        const remaining = listServerPermissionDecisions(coreDb)
          .sort(comparePermissionDecisionPositions)
          .filter(
            (decision) => !position || comparePermissionDecisionPositions(decision, position) > 0
          );
        const permissionDecisions =
          input.limit === undefined ? remaining : remaining.slice(0, input.limit);
        const last = permissionDecisions.at(-1);
        return {
          permissionDecisions,
          nextCursor:
            last && permissionDecisions.length < remaining.length
              ? Buffer.from(
                  JSON.stringify(['permission.server-list', last.createdAt, last.decisionId])
                ).toString('base64url')
              : null,
        };
      } catch (error) {
        governanceReadFailure(error);
      }
    },
  } satisfies FamilyImplementations<typeof GOVERNANCE_OPERATION_DEFINITIONS>;
}

type TimelineEvidenceFilter = z.infer<typeof TimelineEvidenceFilterSchema>;

/** Continuations retain their original narrowing selectors; a supplied selector cannot widen or replace them. */
function selectTimelineEvidenceFilter(
  input: TimelineEvidenceFilter,
  retained?: TimelineEvidenceFilter
): TimelineEvidenceFilter {
  const supplied = TimelineEvidenceFilterSchema.parse({
    turnId: input.turnId,
    capabilityCallId: input.capabilityCallId,
    itemId: input.itemId,
  });
  if (!retained) return supplied;
  for (const key of ['turnId', 'capabilityCallId', 'itemId'] as const)
    if (supplied[key] !== undefined && supplied[key] !== retained[key])
      throw new OperationError(
        'invalid_request',
        'An evidence continuation cannot change its selectors.',
        400
      );
  return retained;
}

/** Exact retained identifiers intersect before pagination; a call's own identity is its call selector. */
function matchesTimelineEvidence(
  row: { turnId?: string | null; itemId?: string | null; capabilityCallId?: string | null },
  filter: TimelineEvidenceFilter,
  callId = row.capabilityCallId
): boolean {
  return (
    (!filter.turnId || row.turnId === filter.turnId) &&
    (!filter.itemId || row.itemId === filter.itemId) &&
    (!filter.capabilityCallId || callId === filter.capabilityCallId)
  );
}

/** A continuation is a scoped position, not a retained anchor or an authorization grant. */
const workspaceAuditCursorSchema = z.tuple([
  z.literal('audit.workspace-list'),
  WorkspaceIdSchema,
  TimelineEvidenceFilterSchema,
  z.union([z.string().datetime(), z.literal('')]),
  AuditEventIdSchema,
]);

const serverAuditCursorSchema = z.tuple([
  z.literal('audit.server-list'),
  TimelineEvidenceFilterSchema,
  z.union([z.string().datetime(), z.literal('')]),
  AuditEventIdSchema,
]);

const workspacePermissionCursorSchema = z.tuple([
  z.literal('permission.workspace-list'),
  WorkspaceIdSchema,
  z.string().datetime(),
  PermissionDecisionIdSchema,
]);

const serverPermissionCursorSchema = z.tuple([
  z.literal('permission.server-list'),
  z.string().datetime(),
  PermissionDecisionIdSchema,
]);

const usageReadCursorSchema = z
  .tuple([
    z.literal('usage.read'),
    WorkspaceIdSchema,
    TimelineEvidenceFilterSchema,
    z.tuple([z.union([z.string().datetime(), z.literal('')]), CapabilityCallIdSchema]).nullable(),
    z.tuple([z.string().datetime(), UsageRecordIdSchema]).nullable(),
  ])
  .refine((value) => value[3] !== null || value[4] !== null);

/** Descending canonical pair order; historical absent timestamps occupy the minimum position. */
function compareWorkspaceAuditPositions(
  left: Pick<AuditEvent, 'createdAt' | 'id'>,
  right: Pick<AuditEvent, 'createdAt' | 'id'>
): number {
  return (
    compareCodeUnits(right.createdAt ?? '', left.createdAt ?? '') ||
    compareCodeUnits(right.id, left.id)
  );
}

/** Descending canonical pair order for permission decisions. */
function comparePermissionDecisionPositions(
  left: { createdAt: string; decisionId: string },
  right: { createdAt: string; decisionId: string }
): number {
  return (
    compareCodeUnits(right.createdAt, left.createdAt) ||
    compareCodeUnits(right.decisionId, left.decisionId)
  );
}

/** Reject malformed or foreign positions without reading an anchor or disclosing cursor content. */
function decodeWorkspaceAuditCursor(cursor: string | undefined, workspaceId: string) {
  if (cursor === undefined) return undefined;
  try {
    const bytes = Buffer.from(cursor, 'base64url');
    const position = workspaceAuditCursorSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (bytes.toString('base64url') !== cursor || position[1] !== workspaceId) {
      throw new Error('Invalid audit continuation.');
    }
    return { filters: position[2], createdAt: position[3], id: position[4] };
  } catch {
    throw new OperationError('invalid_request', 'Invalid audit continuation.', 400);
  }
}

/** Reject malformed server audit continuations without disclosing cursor content. */
function decodeServerAuditCursor(cursor: string | undefined) {
  if (cursor === undefined) return undefined;
  try {
    const bytes = Buffer.from(cursor, 'base64url');
    const position = serverAuditCursorSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (bytes.toString('base64url') !== cursor) {
      throw new Error('Invalid audit continuation.');
    }
    return { filters: position[1], createdAt: position[2], id: position[3] };
  } catch {
    throw new OperationError('invalid_request', 'Invalid audit continuation.', 400);
  }
}

/** Reject malformed or cross-Workspace permission decision continuations. */
function decodeWorkspacePermissionCursor(cursor: string | undefined, workspaceId: string) {
  if (cursor === undefined) return undefined;
  try {
    const bytes = Buffer.from(cursor, 'base64url');
    const position = workspacePermissionCursorSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (bytes.toString('base64url') !== cursor || position[1] !== workspaceId) {
      throw new Error('Invalid permission decision continuation.');
    }
    return { createdAt: position[2], decisionId: position[3] };
  } catch {
    throw new OperationError('invalid_request', 'Invalid permission decision continuation.', 400);
  }
}

/** Reject malformed server permission decision continuations. */
function decodeServerPermissionCursor(cursor: string | undefined) {
  if (cursor === undefined) return undefined;
  try {
    const bytes = Buffer.from(cursor, 'base64url');
    const position = serverPermissionCursorSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (bytes.toString('base64url') !== cursor) {
      throw new Error('Invalid permission decision continuation.');
    }
    return { createdAt: position[1], decisionId: position[2] };
  } catch {
    throw new OperationError('invalid_request', 'Invalid permission decision continuation.', 400);
  }
}

/** Reject malformed or cross-Workspace usage continuations. */
function decodeUsageReadCursor(cursor: string | undefined, workspaceId: string) {
  if (cursor === undefined) return undefined;
  try {
    const bytes = Buffer.from(cursor, 'base64url');
    const position = usageReadCursorSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (bytes.toString('base64url') !== cursor || position[1] !== workspaceId) {
      throw new Error('Invalid usage continuation.');
    }
    return { filters: position[2], call: position[3], usage: position[4] };
  } catch {
    throw new OperationError('invalid_request', 'Invalid usage continuation.', 400);
  }
}

/** Retained decoders publish a fixed failure; arbitrary exceptions retain the shared error boundary. */
function governanceReadFailure(error: unknown): never {
  if (error instanceof OperationError) throw error;
  if (error instanceof SyntaxError || error instanceof z.ZodError)
    throw new OperationError('not_found', 'The retained record could not be read.', 404, {
      cause: error,
    });
  if (error instanceof StoreRecordNotFoundError)
    throw new OperationError('not_found', error.message, 404, { cause: error });
  throw error;
}
