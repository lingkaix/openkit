import type { GOVERNANCE_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
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
          return {
            workspaceId,
            capabilityCalls: listWorkspaceCapabilityCalls(workspaceDb, workspaceId)
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
              }),
            usageRecords: listWorkspaceUsageRecords(workspaceDb, workspaceId).filter(
              (usage) =>
                !usage.threadId ||
                isThreadIdVisible(
                  dependencies.store!,
                  workspaceId,
                  usage.threadId,
                  publicOperationActor(context).userId,
                  isCurrentDeploymentAdministrator(coreDb!, publicOperationActor(context))
                )
            ),
          };
        } finally {
          workspaceDb.sqlite.close();
        }
      } catch (error) {
        governanceReadFailure(error);
      }
    },
    'audit.workspace-list': (input) => {
      try {
        const workspaceId = input.workspaceId;
        const workspaceDb = repositoryWorkspaceDb!(workspaceId);

        try {
          return {
            workspaceId,
            auditEvents: listWorkspaceAuditEvents(workspaceDb, workspaceId),
          };
        } finally {
          workspaceDb.sqlite.close();
        }
      } catch (error) {
        governanceReadFailure(error);
      }
    },
    'audit.server-list': () => {
      try {
        if (!coreDb) {
          throw new OperationError(
            'server_audit_storage_unavailable',
            'Server audit storage is unavailable for this NanoCore instance.',
            503
          );
        }

        return {
          auditEvents: listServerAuditEvents(coreDb),
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
          return {
            workspaceId,
            permissionDecisions: listExportableWorkspacePermissionDecisions(
              workspaceDb,
              workspaceId
            ),
          };
        } finally {
          workspaceDb.sqlite.close();
        }
      } catch (error) {
        governanceReadFailure(error);
      }
    },
    'permission.server-list': () => {
      try {
        if (!coreDb) {
          throw new OperationError('not_found', 'Core DB is not available.', 404);
        }

        return {
          permissionDecisions: listServerPermissionDecisions(coreDb),
        };
      } catch (error) {
        governanceReadFailure(error);
      }
    },
  } satisfies FamilyImplementations<typeof GOVERNANCE_OPERATION_DEFINITIONS>;
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
