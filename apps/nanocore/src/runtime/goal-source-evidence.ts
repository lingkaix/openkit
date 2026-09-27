import { createHash } from 'node:crypto';

import type { FsStore } from '../lib/store.js';
import {
  listExportableWorkspacePermissionDecisions,
  WORKER_TURN_LAUNCH_POLICY_SNAPSHOT_ID,
} from '../policy/permission-decisions.js';
import type { WorkspaceDb } from '../storage/db.js';
import type { GoalPlanOutput } from './goal-plan.js';
import { listGoalReviewRecordsForTask } from './goal-review-records.js';
import { listGoalTasks } from './goal-store.js';

/** Exact current approved-Plan Task and accepted-evidence source for one successor proposal. */
export interface GoalSourceEvidenceInput {
  /** Workspace that owns the Goal. */
  readonly workspaceId: string;
  /** Thread that owns the Goal. */
  readonly threadId: string;
  /** Goal whose active Tasks are snapshotted. */
  readonly goalId: string;
  /** Active approved Plan whose work is being replaced. */
  readonly planItemId: string;
}

/** Captures the ordered active-Plan Task, Review, and accepted evidence facts at model admission. */
export function captureGoalTaskEvidenceSnapshot(
  store: FsStore,
  workspaceDb: WorkspaceDb,
  input: GoalSourceEvidenceInput
) {
  const items = new Map(
    store.listThreadItems(input.workspaceId, input.threadId).map((item) => [item.id, item])
  );
  const tasks = listGoalTasks(workspaceDb, input)
    .filter((task) => task.planItemId === input.planItemId)
    .sort((a, b) => a.orderIndex - b.orderIndex || a.taskId.localeCompare(b.taskId));
  const launches = listExportableWorkspacePermissionDecisions(
    workspaceDb,
    input.workspaceId
  ).filter(
    (decision) =>
      decision.policySnapshotId === WORKER_TURN_LAUNCH_POLICY_SNAPSHOT_ID &&
      decision.action === 'runtime.launch' &&
      decision.result === 'allow' &&
      decision.enforcementPoint === 'runtime.worker_turn_loop.start'
  );
  const snapshot = tasks.map((task) => {
    const reviews = listGoalReviewRecordsForTask(workspaceDb, {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      goalId: input.goalId,
      taskId: task.taskId,
    }).map((review) => ({
      reviewId: review.reviewId,
      verdict: review.verdict,
      resolutionSnapshot: review.resolutionSnapshot,
      acceptedEvidence:
        review.verdict === 'accept'
          ? {
              items: review.itemIds.map((id) => {
                const item = items.get(id);
                if (!item) throw new Error(`Accepted Goal evidence Item is missing: ${id}.`);
                return {
                  id,
                  digest: `sha256:${createHash('sha256').update(JSON.stringify(item)).digest('hex')}`,
                };
              }),
              artifacts: review.artifactIds.map((id) => {
                const artifact = store.getArtifact(input.workspaceId, id);
                return { id, version: artifact.version, digest: artifact.contentDigest };
              }),
            }
          : null,
    }));
    let acceptedOutcome: {
      turnId: string;
      items: { id: string; digest: string }[];
      artifacts: { id: string; version: number; digest: string }[];
    } | null = null;
    if (
      task.status === 'completed' &&
      task.reviewPolicy.required &&
      !reviews.some((review) => review.verdict === 'accept')
    ) {
      throw new Error(`Completed Goal Task ${task.taskId} has no accepted required Review.`);
    }
    if (
      task.status === 'completed' &&
      !task.reviewPolicy.required &&
      !reviews.some((review) => review.verdict === 'accept')
    ) {
      const completedTurns = launches.flatMap((decision) => {
        const resource = decision.resourceSummary as Record<string, unknown>;
        if (
          resource.workspaceId !== input.workspaceId ||
          resource.threadId !== input.threadId ||
          resource.goalId !== input.goalId ||
          resource.taskId !== task.taskId ||
          typeof resource.turnId !== 'string'
        )
          return [];
        const turn = store.getTurn(input.workspaceId, input.threadId, resource.turnId);
        return turn.status === 'completed' &&
          !turn.items.some(
            (item) => item.type === 'user-input-request' || item.type === 'approval-request'
          )
          ? [turn]
          : [];
      });
      if (completedTurns.length === 1) {
        const turn = completedTurns[0]!;
        const outcomeItems = [...items.values()].filter(
          (item) =>
            item.turnId === turn.id &&
            item.status === 'completed' &&
            ['assistant-message', 'artifact-reference', 'command-execution', 'status'].includes(
              item.type
            )
        );
        const artifactIds = [
          ...new Set(
            outcomeItems.flatMap((item) =>
              item.type === 'artifact-reference' ? [item.artifactId] : []
            )
          ),
        ];
        acceptedOutcome = {
          turnId: turn.id,
          items: outcomeItems.map((item) => ({
            id: item.id,
            digest: `sha256:${createHash('sha256').update(JSON.stringify(item)).digest('hex')}`,
          })),
          artifacts: artifactIds.map((id) => {
            const artifact = store.getArtifact(input.workspaceId, id);
            return { id, version: artifact.version, digest: artifact.contentDigest };
          }),
        };
      }
    }
    return { taskId: task.taskId, status: task.status, reviews, acceptedOutcome };
  });
  return {
    facts: snapshot,
    digest: `sha256:${createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')}`,
  };
}

/** Hashes the current source facts for exact successor approval. */
export function computeGoalTaskEvidenceDigest(
  store: FsStore,
  workspaceDb: WorkspaceDb,
  input: GoalSourceEvidenceInput
): string {
  return captureGoalTaskEvidenceSnapshot(store, workspaceDb, input).digest;
}

/** Resolves candidate Item and Artifact refs against current owners and rejects unaccepted predecessor output. */
export function resolveGoalPlanResourceEvidence(
  store: FsStore,
  workspaceDb: WorkspaceDb,
  input: GoalSourceEvidenceInput,
  plan: GoalPlanOutput,
  snapshot: ReturnType<typeof captureGoalTaskEvidenceSnapshot>
) {
  const acceptedItems = new Set(
    snapshot.facts.flatMap((task) => [
      ...task.reviews.flatMap(
        (review) => review.acceptedEvidence?.items.map((item) => item.id) ?? []
      ),
      ...(task.acceptedOutcome?.items.map((item) => item.id) ?? []),
    ])
  );
  const acceptedArtifacts = new Set(
    snapshot.facts.flatMap((task) => [
      ...task.reviews.flatMap(
        (review) => review.acceptedEvidence?.artifacts.map((artifact) => artifact.id) ?? []
      ),
      ...(task.acceptedOutcome?.artifacts.map((artifact) => artifact.id) ?? []),
    ])
  );
  const taskIds = new Set(snapshot.facts.map((task) => task.taskId));
  const predecessorTurnIds = new Set(
    listExportableWorkspacePermissionDecisions(workspaceDb, input.workspaceId).flatMap(
      (decision) => {
        if (
          decision.policySnapshotId !== WORKER_TURN_LAUNCH_POLICY_SNAPSHOT_ID ||
          decision.action !== 'runtime.launch' ||
          decision.result !== 'allow'
        )
          return [];
        const resource = decision.resourceSummary as Record<string, unknown>;
        return resource.workspaceId === input.workspaceId &&
          resource.threadId === input.threadId &&
          resource.goalId === input.goalId &&
          typeof resource.taskId === 'string' &&
          taskIds.has(resource.taskId) &&
          typeof resource.turnId === 'string'
          ? [resource.turnId]
          : [];
      }
    )
  );
  const items = store.listThreadItems(input.workspaceId, input.threadId);
  const resources = plan.tasks
    .flatMap((task) => task.resources)
    .filter((resource) => resource.kind === 'item' || resource.kind === 'artifact');
  return resources.map((resource) => {
    if (resource.kind === 'item') {
      const item = items.find(
        (candidate) => candidate.id === resource.reference && candidate.status === 'completed'
      );
      if (!item)
        throw new Error(
          `Goal Plan Item resource is missing or not completed: ${resource.reference}.`
        );
      if (predecessorTurnIds.has(item.turnId) && !acceptedItems.has(item.id)) {
        throw new Error(`Goal Plan Item resource is unaccepted predecessor output: ${item.id}.`);
      }
      return {
        kind: 'item' as const,
        id: item.id,
        digest: `sha256:${createHash('sha256').update(JSON.stringify(item)).digest('hex')}`,
      };
    }
    const artifact = store.getArtifact(input.workspaceId, resource.reference);
    const predecessorReferences = items.filter(
      (item) =>
        item.type === 'artifact-reference' &&
        item.artifactId === artifact.id &&
        predecessorTurnIds.has(item.turnId)
    );
    if (predecessorReferences.length > 0 && !acceptedArtifacts.has(artifact.id)) {
      throw new Error(
        `Goal Plan Artifact resource is unaccepted predecessor output: ${artifact.id}.`
      );
    }
    return {
      kind: 'artifact' as const,
      id: artifact.id,
      version: artifact.version,
      digest: artifact.contentDigest,
    };
  });
}

/** Binds frozen Task facts and exact candidate resource content into one successor source digest. */
export function goalPlanSourceEvidenceDigest(
  snapshot: ReturnType<typeof captureGoalTaskEvidenceSnapshot>,
  resources: ReturnType<typeof resolveGoalPlanResourceEvidence>
): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify({ facts: snapshot.facts, resources }))
    .digest('hex')}`;
}

/** Requires explicit model-authored treatment of each completed predecessor result. */
export function assertGoalPlanCompletedResultTreatment(
  plan: GoalPlanOutput,
  snapshot: ReturnType<typeof captureGoalTaskEvidenceSnapshot>
): void {
  const used = new Set(
    plan.tasks.flatMap((task) =>
      task.resources
        .filter((resource) => resource.kind === 'item' || resource.kind === 'artifact')
        .map((resource) => resource.reference)
    )
  );
  for (const task of snapshot.facts.filter((candidate) => candidate.status === 'completed')) {
    const acceptedIds = [
      ...task.reviews.flatMap((review) =>
        review.acceptedEvidence
          ? [
              ...review.acceptedEvidence.items.map((item) => item.id),
              ...review.acceptedEvidence.artifacts.map((artifact) => artifact.id),
            ]
          : []
      ),
      ...(task.acceptedOutcome?.items.map((item) => item.id) ?? []),
      ...(task.acceptedOutcome?.artifacts.map((artifact) => artifact.id) ?? []),
    ];
    if (acceptedIds.some((id) => used.has(id))) continue;
    if (
      !plan.assumptions.some(
        (assumption) => assumption.includes(task.taskId) && assumption.trim() !== task.taskId
      )
    ) {
      throw new Error(`Goal Plan must explain exclusion of completed Task ${task.taskId} result.`);
    }
  }
}
