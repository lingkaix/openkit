import { isDeepStrictEqual } from 'node:util';
import { computeReadiness, isAgentLaunchable } from '../agents/readiness.js';
import { selectAgent } from '../agents/selector.js';
import {
  type AgentSetupResolverDependencies,
  resolveAgentSetup,
} from '../agents/setup-resolver.js';
import { type RuntimeConfigSnapshot, resolveDefaultAgentId } from '../config/runtime-config.js';
import type { FsStore } from '../lib/store.js';
import type {
  RecurringAdmissionPayload,
  RecurringOccurrence,
  RecurringPreparation,
} from '../storage/recurring-records.js';
import { TurnStartValidationError } from './orchestrator.js';
import { materializeWorkspaceRootsForTurn } from './turn-workspace-context.js';

/** Current Core-local setup supply; this boundary has no runtime or provider invocation port. */
export interface PrepareRecurringOccurrenceInput
  extends Pick<
    AgentSetupResolverDependencies,
    'providerCredentialConfigured' | 'subscriptionAccounts'
  > {
  readonly occurrence: RecurringOccurrence;
  readonly snapshot: RuntimeConfigSnapshot;
  readonly store: FsStore;
  readonly backendId: string | null;
}

/** Resolves once, then revalidates the complete frozen selection without substituting current defaults. */
export async function prepareRecurringOccurrence(
  input: PrepareRecurringOccurrenceInput
): Promise<RecurringPreparation> {
  if (!input.backendId) return { kind: 'failure', code: 'scheduler_unavailable' };
  const { occurrence, snapshot } = input;
  const frozen = occurrence.resolvedPayload;
  const agentId = frozen?.requestedAgentId ?? occurrence.snapshot.agentId;
  const selected = selectAgent(
    {
      defaultAgentId: resolveDefaultAgentId(
        snapshot,
        occurrence.workspaceId,
        occurrence.snapshot.actor.responsibleUserId
      ),
    },
    agentId ? { agentId } : {},
    snapshot.agentManifests
  );
  if (!('id' in selected) || !isAgentLaunchable(computeReadiness(selected)))
    return { kind: 'failure', code: 'selection_unavailable' };
  const workspaceConfig = snapshot.workspaceConfigs.find(
    (entry) => entry.workspaceId === occurrence.workspaceId
  )?.config;
  const userConfig = snapshot.userConfigs.find(
    (entry) => entry.userId === occurrence.snapshot.actor.responsibleUserId
  )?.config;
  const resolved = resolveAgentSetup(selected, {
    gatewayConfig: snapshot.gatewayConfig,
    providerRegistry: snapshot.providerRegistry,
    providerCredentialConfigured: input.providerCredentialConfigured,
    subscriptionAccounts: input.subscriptionAccounts,
    workspaceId: occurrence.workspaceId,
    ...(workspaceConfig ? { workspaceConfig } : {}),
    ...(userConfig ? { userConfig } : {}),
    selectedProfileId: frozen ? frozen.profileRef : (occurrence.snapshot.profileId ?? null),
    requestedLogicalModelId: frozen?.modelId ?? occurrence.snapshot.modelId ?? null,
  });
  if (!resolved.setup || resolved.diagnostics.length)
    return { kind: 'failure', code: 'selection_unavailable' };
  let workspaceRoots: RecurringAdmissionPayload['workspaceRoots'];
  try {
    workspaceRoots = materializeWorkspaceRootsForTurn(
      snapshot,
      input.store,
      occurrence.workspaceId,
      selected
    );
  } catch (error) {
    if (error instanceof TurnStartValidationError)
      return { kind: 'failure', code: 'preparation_failed' };
    throw error;
  }
  const reasoningEffort = resolved.setup.manifest.models.reasoningEffort;
  const payload: RecurringAdmissionPayload = {
    backendId: input.backendId,
    requestedAgentId: selected.id,
    profileRef: resolved.setup.profileId,
    modelId: resolved.setup.logicalModels.preferredLogicalModelId,
    workspaceRoots,
    workspaceCwd:
      workspaceRoots.find((root) => root.sourceKind === 'remote-git')?.workerPath ?? null,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  };
  if (frozen && !isDeepStrictEqual(frozen, payload))
    return { kind: 'failure', code: 'selection_unavailable' };
  return { kind: 'ready', payload };
}
