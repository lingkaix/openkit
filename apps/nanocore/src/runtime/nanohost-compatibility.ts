import { createHash } from 'node:crypto';
import {
  type AgentEnvironmentPackage,
  planSessionWorkspaceMaterialization,
  sessionStaticControl,
} from '@openkit/config-schema';
import { responsibleUserIdForActor } from '@openkit/protocol';
import { workerSessionInputPaths } from '@openkit/worker-protocol';
import type { AgentEnvironmentPackagePreview } from './agent-environment.js';
import { stableNanoHostEffectJson } from './nanohost-effect-identity.js';

/** Hashes only the exact inputs that decide physical Sandbox reuse. */
export function nanoHostSandboxCompatibilityKey(
  environmentPackage: AgentEnvironmentPackagePreview
): string {
  const responsibleUserId = responsibleUserIdForActor(environmentPackage.scope.triggerActor);
  const {
    root: sessionRoot,
    contextRoot,
    packagePath,
  } = workerSessionInputPaths(environmentPackage.scope.agentSessionId);
  const { layout, materialization } = planSessionWorkspaceMaterialization({ environmentPackage });
  const mainWorktreePath = layout.slots.find((slot) => slot.id === 'main-worktree')?.path;
  const filesystem = environmentPackage.policy.filesystem;
  return createHash('sha256')
    .update(
      stableNanoHostEffectJson({
        backend: environmentPackage.backend,
        credentials: environmentPackage.credentials,
        ...(environmentPackage.credentials.declarations.some(
          (item) => item.visibility === 'runtime-file'
        )
          ? { credentialAgentSessionId: environmentPackage.scope.agentSessionId }
          : {}),
        policy: {
          ...environmentPackage.policy,
          ...(filesystem
            ? {
                filesystem: {
                  ...filesystem,
                  rules: filesystem.rules.map((rule) => {
                    if (
                      !rule ||
                      typeof rule !== 'object' ||
                      Array.isArray(rule) ||
                      !('workerPath' in rule)
                    ) {
                      return rule;
                    }
                    if (
                      'id' in rule &&
                      rule.id === 'openkit-context-package' &&
                      rule.workerPath === contextRoot
                    ) {
                      return { ...rule, workerPath: 'agent-session-context' };
                    }
                    if (rule.workerPath === mainWorktreePath) {
                      return { ...rule, workerPath: 'worker-storage-worktree' };
                    }
                    // Only planner-bound input rules lose private paths; other policy stays literal.
                    const binding = materialization.inputs.find(
                      (input) => 'id' in rule && input.inputId === rule.id
                    );
                    const slot = layout.slots.find((entry) => entry.id === binding?.slotId);
                    if (
                      slot &&
                      (slot.id === 'turn-inputs' || slot.id === 'artifact-input') &&
                      slot.path === rule.workerPath &&
                      typeof rule.workerPath === 'string' &&
                      rule.workerPath.startsWith(`${sessionRoot}/`) &&
                      environmentPackage.workspace.inputs.some(
                        (input) => input.id === binding?.inputId && input.target === rule.workerPath
                      )
                    ) {
                      return {
                        ...rule,
                        workerPath: `agent-session${rule.workerPath.slice(sessionRoot.length)}`,
                      };
                    }
                    return rule;
                  }),
                },
              }
            : {}),
        },
        responsibleUserTrust: {
          actorKind: environmentPackage.scope.triggerActor.kind,
          responsibleUserId,
        },
        resources: environmentPackage.resources,
        runtimeImage: environmentPackage.runtime.image,
        runtimeProcess: environmentPackage.runtime.process ?? null,
        schemaVersion: environmentPackage.schemaVersion,
        vault: environmentPackage.vault,
        workspace: {
          generatedFiles: environmentPackage.workspace.generatedFiles.map((file) => ({
            access: file.access,
            id: file.id,
            target:
              file.id === 'agent-environment-package' && file.target === packagePath
                ? 'agent-session-package'
                : file.target,
          })),
          id: environmentPackage.scope.workspaceId,
          // Generated context files are Turn-dynamic inside the declared context slot.
          inputs: environmentPackage.workspace.inputs.flatMap((input, index) =>
            materialization.inputs[index]?.slotId === 'context'
              ? []
              : [
                  nanoHostStaticWorkspaceInput(
                    input,
                    materialization.inputs[index]?.slotId,
                    sessionRoot
                  ),
                ]
          ),
          layout: {
            ...layout,
            layoutId: 'worker-storage-layout',
            workingDirectory:
              layout.workingDirectory === mainWorktreePath
                ? 'worker-storage-worktree'
                : layout.workingDirectory,
            // Private disposable namespaces vary by AgentSession inside one physical Sandbox.
            slots: layout.slots.map((slot) =>
              slot.id === 'context'
                ? { ...slot, path: 'agent-session-context' }
                : slot.id === 'main-worktree'
                  ? { ...slot, path: 'worker-storage-worktree' }
                  : slot.id === 'turn-output'
                    ? { ...slot, path: 'agent-session-output' }
                    : slot.path.startsWith(`${sessionRoot}/`)
                      ? { ...slot, path: `agent-session-slot/${slot.id}` }
                      : slot
            ),
            control: { ...layout.control, contextRoot: 'agent-session-context' },
          },
          outputs: environmentPackage.workspace.outputs.map((output) =>
            output.id === 'turn-output-root' && output.path === `${sessionRoot}/outputs`
              ? { ...output, path: 'agent-session-output' }
              : output.path === mainWorktreePath
                ? { ...output, path: 'worker-storage-worktree' }
                : output
          ),
        },
      })
    )
    .digest('hex');
}

/** Hashes the process-static adapter and Integration configuration of one Harness. */
export function nanoHostHarnessCompatibilityKey(
  environmentPackage: AgentEnvironmentPackagePreview
): string {
  const { openkit, ...extensions } = environmentPackage.extensions ?? {};
  const openkitRecord =
    openkit && typeof openkit === 'object' && !Array.isArray(openkit)
      ? (openkit as Record<string, unknown>)
      : null;
  const {
    turnInput: _turnInput,
    sessionWorkspace: _sessionWorkspace,
    workerStorage: _workerStorage,
    ...staticOpenkit
  } = openkitRecord ?? {};
  return createHash('sha256')
    .update(
      stableNanoHostEffectJson({
        adapter: environmentPackage.control.adapter,
        agentRuntime: {
          kind: environmentPackage.agent.runtimeKind,
          version: environmentPackage.agent.runtimeVersion,
        },
        control: sessionStaticControl({
          transcript: environmentPackage.control.transcript ?? null,
        }),
        credentials: environmentPackage.credentials,
        extensions: { ...extensions, openkit: openkitRecord ? staticOpenkit : openkit },
        resources: environmentPackage.resources,
        runtime: {
          binaries: environmentPackage.runtime.binaries,
          command: {
            ...environmentPackage.runtime.command,
            workingDirectory: 'worker-storage-worktree',
          },
          process: environmentPackage.runtime.process ?? null,
          session: environmentPackage.runtime.session ?? null,
        },
        supply: environmentPackage.supply,
        vault: environmentPackage.vault,
      })
    )
    .digest('hex');
}

/** Removes Turn content lineage while retaining one input's static isolation envelope. */
function nanoHostStaticWorkspaceInput(
  input: AgentEnvironmentPackage['workspace']['inputs'][number],
  slotId: string | undefined,
  sessionRoot: string
): Record<string, unknown> {
  const { commit: _commit, ...source } = input.source;
  const { contentDigest: _contentDigest, ...materialization } = input.materialization ?? {};
  return {
    access: input.access,
    id: slotId === 'context' ? 'context' : input.id,
    kind: input.kind,
    materialization,
    mount: input.mount ?? null,
    source: slotId === 'context' ? { kind: source.kind } : source,
    target:
      slotId === 'context'
        ? 'agent-session-context'
        : slotId === 'main-worktree'
          ? 'worker-storage-worktree'
          : input.target.startsWith(`${sessionRoot}/`)
            ? `agent-session${input.target.slice(sessionRoot.length)}`
            : input.target,
  };
}
