import { THREAD_TIMELINE_PLACEMENT, ThreadDashboardResponseSchema } from '@openkit/app-api-schemas';
import { type Item, ItemTypeSchema } from '@openkit/protocol';
import { readScopedHumanAttention } from './action-center.js';
import type { readThreadDashboard } from './app-dashboard.js';
import { isWorkspaceOperationAuthorized } from './auth/operation-authorizer.js';
import { isArtifactVisible } from './auth/thread-visibility.js';
import { boundedJsonText } from './bounded-read-text.js';
import { resolveDefaultAgentId } from './config/runtime-config.js';
import { findNamedAgentEnvironmentPackageSnapshot } from './runtime/aep-snapshot-ledger.js';
import { readGoalAttentionScope } from './runtime/goal-owner.js';
import { readLatestThreadRuntimeObservation } from './runtime/runtime-evidence.js';
import { findSchedulerAdmissionForTurn } from './scheduler-records.js';
import { projectTimelineItem } from './thread-timeline.js';
import { projectProductTurn } from './turn-error-presentation.js';

/** Current bounded dashboard joins each source only after its own admission. */
export function readBoundedThreadDashboard(input: Parameters<typeof readThreadDashboard>[0]) {
  const { store, coreDb, workspaceId, threadId, actor, administratorEligible } = input;
  const thread = store.getThread(workspaceId, threadId);
  const allowed = (
    operation: Parameters<typeof isWorkspaceOperationAuthorized>[3]['policyOperation'],
    mutating = false
  ) =>
    !coreDb ||
    isWorkspaceOperationAuthorized(coreDb, actor, workspaceId, {
      policyOperation: operation,
      mutating,
    });
  const workspaceRead = allowed('workspace.read');
  const observationRead = workspaceRead && allowed('audit.read');
  const canRun = allowed('turn.run', true);
  const defaultAgentId = workspaceRead
    ? resolveDefaultAgentId(input.runtimeConfigManager.current(), workspaceId, actor.userId)
    : null;
  const workspaceDb = coreDb ? input.repositoryWorkspaceDb(workspaceId) : undefined;
  try {
    return store.readThreadTimelineSnapshot(workspaceId, threadId, (snapshot) => {
      const activeTurn = snapshot.activeTurn();
      const current =
        activeTurn ??
        snapshot.turns({
          upper: snapshot.upperOrder,
          direction: 'before',
          limit: 1,
        })[0];
      const record = current?.record;
      const latest = current
        ? projectProductTurn({
            id: record!.id,
            owner: record!.owner,
            threadId,
            status: record!.status,
            triggerActor: record!.triggerActor,
            agentId: record!.agentId ?? null,
            agentProfileId: record!.agentProfileId ?? null,
            configVersion: record!.configVersion,
            reasoningEffort: record!.reasoningEffort,
            startedAt: record!.startedAt,
            completedAt: record!.completedAt,
            durationMs: record!.durationMs,
            error: record!.error
              ? {
                  ...(record!.error as object),
                  code: (record!.error as { code: string | null }).code
                    ? boundedJsonText((record!.error as { code: string }).code, 256)
                    : null,
                  message: boundedJsonText((record!.error as { message: string }).message, 1024),
                }
              : null,
            items: [],
          })
        : null;
      const turnId = latest?.id ?? null;
      const active = latest?.status === 'running' || latest?.status === 'pending';
      const candidates = active
        ? ItemTypeSchema.options
            .filter(
              (type) => THREAD_TIMELINE_PLACEMENT[type] === 'step' && type !== 'knowledge-injection'
            )
            .flatMap((type) =>
              snapshot.currentPositions({ type, turnId: turnId!, status: 'in_progress', limit: 1 })
            )
            .sort((a, b) => b.sequence - a.sequence)
        : [];
      const stepItem = candidates.flatMap((position) => {
        const item = snapshot.item(position.itemId);
        return item?.status === 'in_progress' ? [item] : [];
      })[0];
      const title = (item: Item): string | null =>
        item.type === 'command-execution'
          ? item.command
          : item.type === 'tool-call'
            ? item.tool
            : item.type === 'file-change'
              ? item.path
              : null;
      const step = stepItem
        ? {
            itemId: stepItem.id,
            kind: stepItem.type,
            title: title(stepItem) ? boundedJsonText(title(stepItem)!, 512) : null,
            startedAt: stepItem.createdAt,
          }
        : null;
      const planPosition = snapshot.currentPositions({ type: 'plan', limit: 1 })[0];
      const plan = planPosition ? snapshot.item(planPosition.itemId) : undefined;
      const latestPlan = plan
        ? projectTimelineItem(plan, 4608, {
            store,
            coreDb,
            actor,
            administratorEligible,
            repositoryWorkspaceDb: input.repositoryWorkspaceDb,
            input: { workspaceId, threadId },
          })
        : null;
      const admission =
        coreDb && turnId
          ? findSchedulerAdmissionForTurn(coreDb, { workspaceId, threadId, turnId })
          : null;
      const queuePosition =
        admission?.status === 'queued'
          ? (
              coreDb!.sqlite
                .prepare(`SELECT count(*)+1 AS position FROM scheduler_admission_entries
        WHERE status='queued' AND (enqueued_at<? OR (enqueued_at=? AND queue_entry_id<?))`)
                .get(admission.enqueuedAt, admission.enqueuedAt, admission.queueEntryId) as {
                position: number;
              }
            ).position
          : null;
      const scope = workspaceDb
        ? readGoalAttentionScope(workspaceDb, threadId)
        : { threadIds: [threadId], more: false };
      const scopedAttention = workspaceDb
        ? readScopedHumanAttention({
            ...input,
            workspaceDb,
            threadIds: scope.threadIds,
            reviewLimit: 33,
          })
        : { items: [], pendingRequests: [], more: false };
      const attentionRows = scopedAttention.items;
      const attention = {
        items: attentionRows.slice(0, 8),
        more: scope.more || scopedAttention.more || attentionRows.length > 8,
        restricted: !allowed('approval.respond', true) || !allowed('review.apply', true),
      };
      const pendingRequests = scopedAttention.pendingRequests.filter((request) =>
        attention.items.some(
          (row) =>
            row.id === `approval:${request.requestId}` || row.id === `question:${request.requestId}`
        )
      );
      const artifacts = workspaceRead
        ? snapshot
            .currentPositions({ type: 'artifact-reference', limit: 8 })
            .flatMap((position) => {
              const item = snapshot.item(position.itemId);
              if (item?.type !== 'artifact-reference') return [];
              try {
                const artifact = store.getArtifact(workspaceId, item.artifactId);
                if (
                  !isArtifactVisible(store, artifact, actor.userId, administratorEligible) ||
                  artifact.threadId !== threadId ||
                  artifact.status !== 'ready' ||
                  artifact.version !== item.artifactVersion ||
                  artifact.origin.kind !== 'turn-output'
                )
                  return [];
                return [
                  {
                    id: artifact.id,
                    title: boundedJsonText(artifact.title, 512),
                    status: artifact.status,
                    summary: artifact.summary ? boundedJsonText(artifact.summary, 1024) : null,
                    updatedAt: artifact.updatedAt,
                  },
                ];
              } catch {
                return [];
              }
            })
        : [];
      const uniqueArtifacts = [
        ...new Map(artifacts.reverse().map((artifact) => [artifact.id, artifact])).values(),
      ];
      const actors = latest
        ? [
            latest.triggerActor,
            ...(latest.agentId ? [{ kind: 'agent' as const, id: latest.agentId }] : []),
          ]
        : [];
      const participants = [
        ...new Map(actors.map((entry) => [`${entry.kind}:${entry.id}`, entry])).values(),
      ].map((entry) => {
        const user =
          entry.kind === 'user' && coreDb && (workspaceRead || entry.id === actor.userId)
            ? (coreDb.sqlite
                .prepare('SELECT display_name AS name FROM users WHERE id=?')
                .get(entry.id) as { name: string } | undefined)
            : undefined;
        const agent =
          workspaceRead && entry.kind === 'agent'
            ? input.runtimeConfigManager
                .current()
                .agentManifests.find((manifest) => manifest.id === entry.id)
            : undefined;
        return {
          kind: entry.kind,
          id: entry.id,
          displayName: boundedJsonText(user?.name || agent?.displayName || entry.id, 256),
        };
      });
      const internal = record?.internalExecution as { logicalModelId?: string } | undefined;
      let modelId = internal?.logicalModelId ?? admission?.modelId;
      let modelSource: 'turn-admission' | 'scheduler-admission' | 'package-preference' =
        internal?.logicalModelId ? 'turn-admission' : 'scheduler-admission';
      if (workspaceRead && !modelId && workspaceDb && typeof record?.agentSessionId === 'string') {
        const session = snapshot.agentSession(record.agentSessionId);
        const pointer = session?.record.environmentPackageSnapshotId;
        if (typeof pointer === 'string') {
          try {
            const pkg = findNamedAgentEnvironmentPackageSnapshot(
              workspaceDb,
              workspaceId,
              record.agentSessionId,
              pointer
            );
            if (
              pkg?.snapshot.scope.workspaceId === workspaceId &&
              pkg.snapshot.scope.threadId === threadId &&
              pkg.snapshot.scope.turnId === turnId &&
              pkg.snapshot.scope.agentSessionId === record.agentSessionId
            ) {
              modelId = pkg.snapshot.llm.preferredLogicalModelId;
              modelSource = 'package-preference';
            }
          } catch {
            /* Unproven package intent stays unavailable; current catalog values are not a substitute. */
          }
        }
      }
      let observation: ReturnType<typeof readLatestThreadRuntimeObservation> = null;
      if (observationRead && workspaceDb && turnId) {
        try {
          observation = readLatestThreadRuntimeObservation(
            workspaceDb,
            workspaceId,
            threadId,
            turnId
          );
        } catch {
          /* An unproved source stays unavailable; current attention keeps its independent owner. */
        }
      }
      const environment = {
        visibility: workspaceRead ? ('available' as const) : ('restricted' as const),
        observation,
        observationAvailability: !observationRead
          ? ('restricted' as const)
          : observation
            ? ('available' as const)
            : ('unavailable' as const),
        model:
          workspaceRead && modelId
            ? {
                id: modelId,
                source: modelSource,
              }
            : null,
      };
      const result = {
        viewerUserId: actor.userId,
        participants,
        thread: {
          ...thread,
          name: thread.name ? boundedJsonText(thread.name, 512) : null,
          preview: boundedJsonText(thread.preview, 1024),
        },
        turns: latest ? [latest] : [],
        artifacts: uniqueArtifacts,
        workStatus: {
          selectedAgentId: latest ? (latest.agentId ?? null) : defaultAgentId,
          activeTurnStatus: activeTurn ? latest!.status : 'idle',
          pendingApprovalCount: attentionRows.filter((row) => row.kind === 'approval').length,
          pendingQuestionCount: attentionRows.filter((row) => row.kind === 'question').length,
          latestArtifact: uniqueArtifacts.reduce<(typeof uniqueArtifacts)[number] | null>(
            (latest, artifact) =>
              !latest || artifact.updatedAt > latest.updatedAt ? artifact : latest,
            null
          ),
        },
        composer: { disabled: !canRun, defaultAgentId },
        itemLog: { href: '/api/app/operations/thread.timeline' },
        taskInputs: [],
        pendingRequests,
        coverage: {
          turns: 'current-run' as const,
          participants: 'current-run' as const,
          artifacts: workspaceRead ? ('referenced-window' as const) : ('restricted' as const),
          taskInputs: 'unavailable' as const,
          runtimeActivity: 'unavailable' as const,
        },
        now: {
          turnId,
          status: latest?.status ?? 'idle',
          step,
          lastEventAt: turnId ? snapshot.lastEventAt(turnId) : null,
          queuePosition,
          stepsReportedLive: step ? true : null,
        },
        latestPlan,
        attention,
        environment,
      };
      while (Buffer.byteLength(JSON.stringify(result)) > 32768 && result.attention.items.length) {
        result.attention.items.pop();
        result.attention.more = true;
      }
      while (Buffer.byteLength(JSON.stringify(result)) > 32768 && result.artifacts.length)
        result.artifacts.pop();
      if (Buffer.byteLength(JSON.stringify(result)) > 32768)
        throw new TypeError('Dashboard exceeds its bounded source budget.');
      return ThreadDashboardResponseSchema.parse(result);
    });
  } finally {
    workspaceDb?.sqlite.close();
  }
}
