import {
  AgentNativeEnvironmentResponseSchema,
  UpdateAgentNativeEnvironmentRequestSchema,
} from '@openkit/app-api-schemas';
import { AuthoredAgentConfigSchema } from '@openkit/config-schema';
import {
  canonicalNativeEnvironment,
  isProtectedNativeEnvironmentName,
  NativeEnvironmentRecordSchema,
} from '@openkit/worker-protocol';
import { applyEdits, modify, type ParseError, parse } from 'jsonc-parser';
import type { Actor } from '../auth/identity.js';
import {
  isWorkspaceOperationAuthorized,
  requireCurrentDeploymentAdmin,
} from '../auth/operation-authorizer.js';
import { isThreadIdVisible } from '../auth/thread-visibility.js';
import type { FsStore } from '../lib/store.js';
import { resolvePublicNativeEnvironment } from '../runtime/native-environment.js';
import { readAdmittedWorkerImageEnvironment } from '../runtime/worker-image-settlements.js';
import type { CoreDb } from '../storage/db.js';
import type { RuntimeConfigManager } from './runtime-config.js';
import {
  type RuntimeConfigFileService,
  RuntimeConfigFileServiceError,
} from './runtime-config-files.js';

/** Existing configuration/CAS/reload projection for administrator-managed native settings. */
export function createAgentNativeEnvironmentService(input: {
  coreDb: CoreDb;
  store: FsStore;
  manager: RuntimeConfigManager;
  filesForActor: (actor: Actor) => Pick<RuntimeConfigFileService, 'readFile' | 'updateFile'>;
  onReloadApplied?: () => void;
}) {
  const read = (actor: Actor, fileId: string) => {
    requireCurrentDeploymentAdmin(input.coreDb, actor);
    const source = input.filesForActor(actor).readFile(fileId);
    if (source.file.kind !== 'agent')
      throw new RuntimeConfigFileServiceError(
        'invalid_request',
        'An Agent configuration is required.',
        400
      );
    const errors: ParseError[] = [];
    const json = parse(source.content, errors);
    if (errors.length)
      throw new RuntimeConfigFileServiceError(
        'invalid_request',
        'Agent configuration is invalid.',
        400
      );
    const manifest = AuthoredAgentConfigSchema.parse(json);
    const desired = resolvePublicNativeEnvironment(input.coreDb, manifest);
    return { source, manifest, desired };
  };

  return {
    /** Shows admitted defaults, authored intent, reload and audience-scoped native acknowledgement. */
    view(actor: Actor, fileId: string) {
      const { source, manifest, desired } = read(actor, fileId);
      const defaults = readAdmittedWorkerImageEnvironment(input.coreDb, desired.imageDigest)!;
      const snapshot = input.manager.current();
      const reloaded = snapshot.agentManifests.find((agent) => agent.id === manifest.id);
      const rows = input.coreDb.sqlite
        .prepare(`SELECT b.workspace_id AS workspaceId, b.thread_id AS threadId, b.lifecycle_state AS lifecycleState, b.cleanup_state AS cleanupState, h.lifecycle_state AS harnessState, s.lifecycle_state AS sandboxState, t.ready AS targetReady, t.physical_epoch AS physicalEpoch, s.origin_physical_epoch AS originEpoch,
        b.native_environment_json AS environment, b.native_environment_applied AS applied FROM agent_session_runtime_bindings b JOIN harness_instance_records h ON h.harness_instance_id = b.harness_instance_id LEFT JOIN sandbox_runtime_records s ON s.sandbox_runtime_id = h.sandbox_runtime_id LEFT JOIN nanohost_runtime_targets t ON t.target_id = s.runtime_target_id WHERE b.native_environment_json IS NOT NULL`)
        .all() as {
        workspaceId: string;
        threadId: string;
        lifecycleState: string;
        cleanupState: string;
        harnessState: string;
        sandboxState: string | null;
        targetReady: number | null;
        physicalEpoch: string | null;
        originEpoch: string | null;
        environment: string;
        applied: number;
      }[];
      const applied = rows.flatMap((row) => {
        if (
          !isWorkspaceOperationAuthorized(input.coreDb, actor, row.workspaceId, {
            authentication: 'deployment-admin',
            mutating: false,
            policyOperation: 'workspace.read',
          }) ||
          !isThreadIdVisible(input.store, row.workspaceId, row.threadId, actor.userId)
        )
          return [];
        const record = JSON.parse(row.environment) as Record<string, unknown>;
        if (record.agentId !== manifest.id) return [];
        const environment = NativeEnvironmentRecordSchema.parse(record);
        const state =
          !['open', 'active', 'opening'].includes(row.lifecycleState) ||
          row.cleanupState !== 'clean' ||
          row.harnessState !== 'open' ||
          row.sandboxState !== 'open' ||
          row.targetReady !== 1 ||
          !row.originEpoch ||
          row.physicalEpoch !== row.originEpoch
            ? ('unknown' as const)
            : row.applied === 1
              ? ('acknowledged' as const)
              : ('pending' as const);
        return [
          {
            workspaceId: row.workspaceId,
            threadId: row.threadId,
            state,
            environment: state === 'acknowledged' ? environment : null,
            matchesDesired:
              state === 'acknowledged' &&
              environment.imageDigest === desired.imageDigest &&
              environment.defaultsDigest === desired.defaultsDigest &&
              canonicalNativeEnvironment(environment.values) ===
                canonicalNativeEnvironment(desired.values),
          },
        ];
      });
      return AgentNativeEnvironmentResponseSchema.parse({
        agentId: manifest.id,
        fileId,
        persistedRevision: source.file.revision,
        defaults: defaults.values,
        overrides: manifest.runtime.environment ?? {},
        managedNames: Object.keys(defaults.values)
          .filter((name) => isProtectedNativeEnvironmentName(name, manifest.runtime.adapter))
          .sort(),
        desired,
        reload: {
          matchesDesired:
            !!reloaded &&
            JSON.stringify(reloaded.runtime.image) === JSON.stringify(manifest.runtime.image) &&
            canonicalNativeEnvironment(reloaded.runtime.environment ?? {}) ===
              canonicalNativeEnvironment(manifest.runtime.environment ?? {}),
          snapshotVersion: snapshot.version,
        },
        applied,
        sharedAgentImpact: 'All later Turns using this Agent.',
      });
    },

    /** Writes the sole authored map through existing revision CAS, then invokes safe reload. */
    update(actor: Actor, unsafeRequest: unknown) {
      const request = UpdateAgentNativeEnvironmentRequestSchema.parse(unsafeRequest);
      const { source, manifest, desired } = read(actor, request.fileId);
      if (
        source.file.revision !== request.expectedRevision ||
        desired.imageDigest !== request.imageDigest ||
        desired.defaultsDigest !== request.defaultsDigest
      )
        throw new RuntimeConfigFileServiceError(
          'revision_conflict',
          'Agent configuration or image evidence changed.',
          409
        );
      const next = AuthoredAgentConfigSchema.parse({
        ...manifest,
        runtime: { ...manifest.runtime, environment: request.environment },
      });
      resolvePublicNativeEnvironment(input.coreDb, next);
      const content = applyEdits(
        source.content,
        modify(source.content, ['runtime', 'environment'], request.environment, {
          formattingOptions: { insertSpaces: true, tabSize: 2 },
        })
      );
      requireCurrentDeploymentAdmin(input.coreDb, actor);
      input.filesForActor(actor).updateFile({
        id: request.fileId,
        kind: 'agent',
        expectedRevision: request.expectedRevision,
        content,
      });
      const reload = input.manager.reload({ mode: 'safe', dryRun: false });
      if (reload.status === 'applied') input.onReloadApplied?.();
      return this.view(actor, request.fileId);
    },
  };
}
