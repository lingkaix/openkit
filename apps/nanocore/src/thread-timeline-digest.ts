import { THREAD_TIMELINE_LIMITS, type ThreadTimelineResponse } from '@openkit/app-api-schemas';
import { type Item, TurnRecordSchema } from '@openkit/protocol';
import { readScopedHumanAttention } from './action-center.js';
import { isWorkspaceOperationAuthorized } from './auth/operation-authorizer.js';
import type { ThreadItemPosition } from './storage/control-store-product-records.js';
import { isRecordedItemFailure } from './storage/control-store-read-metadata.js';
import type { ThreadTimelineSnapshot } from './storage/workspace-file-records.js';
import { hasWorkspaceReviewArtifact } from './storage/workspace-review-records.js';
import { isThreadItemSourceAllowed, type ThreadTimelineReadInput } from './thread-timeline.js';

type Digest = ThreadTimelineResponse['digest'];
type Kind = Digest['lines'][number]['kind'];

/** Counts retained changes after B, never client display windows or generated prose. Partial counts are lower bounds. */
export function readTimelineDigest(
  owner: ThreadTimelineReadInput,
  snapshot: ThreadTimelineSnapshot,
  boundary: ThreadItemPosition | undefined
): Digest {
  const lines = new Map<Kind, Digest['lines'][number]>();
  const seen = new Set<string>();
  const reviews = new Map<string, string>();
  const result: Digest = { lines: [], coverage: 'complete' };
  const add = (kind: Kind, key: string, anchor: Digest['lines'][number]['anchor'], count = 1) => {
    if (count < 1 || seen.has(`${kind}:${key}`)) return;
    seen.add(`${kind}:${key}`);
    const existing = lines.get(kind);
    if (existing) existing.count += count;
    else lines.set(kind, { kind, count, anchor });
  };
  const after = (position: ThreadItemPosition) =>
    !boundary ||
    position.admissionOrder > boundary.admissionOrder ||
    (position.admissionOrder === boundary.admissionOrder && position.sequence > boundary.sequence);
  const auditAllowed =
    !!owner.coreDb &&
    isWorkspaceOperationAuthorized(owner.coreDb, owner.actor, owner.input.workspaceId, {
      policyOperation: 'audit.read',
      mutating: false,
    });
  const workspaceDb = owner.repositoryWorkspaceDb?.(owner.input.workspaceId);
  try {
    // Reuse the bounded Action Center owner. A communication Item alone cannot create a need.
    if (workspaceDb) {
      const attention = readScopedHumanAttention({
        store: owner.store,
        coreDb: owner.coreDb,
        actor: owner.actor,
        administratorEligible: owner.administratorEligible,
        workspaceId: owner.input.workspaceId,
        workspaceDb,
        threadIds: [owner.input.threadId],
        pendingLimit: 33,
      });
      if (attention.more) result.coverage = 'partial';
      for (const row of attention.items) {
        if (row.source.type === 'artifact_review') {
          reviews.set(
            `${row.source.turnId}:${row.source.artifactId}:${row.source.artifactVersion}`,
            row.id
          );
          continue;
        }
        if (
          !row.itemId ||
          !row.turnId ||
          !row.actions.some(
            (action) =>
              !action.disabled &&
              ['grant_approval', 'answer_question', 'accept_review'].includes(action.kind)
          )
        )
          continue;
        const position = snapshot.position(row.itemId);
        if (position && after(position))
          add('needs-you', row.id, { kind: 'attention', rowId: row.id });
      }
    }
    const rows = snapshot.turns({
      upper: snapshot.upperOrder,
      direction: 'after',
      boundary: boundary ? boundary.admissionOrder - 1 : 0,
      limit: THREAD_TIMELINE_LIMITS.digestRuns,
    });
    const last = rows.at(-1);
    if (
      last &&
      snapshot.turns({
        upper: snapshot.upperOrder,
        direction: 'after',
        boundary: last.admissionOrder,
        limit: 1,
      }).length
    )
      result.coverage = 'partial';
    const boundaryCreatedAt = boundary ? snapshot.itemCreatedAt(boundary.itemId) : undefined;
    if (boundary && !boundaryCreatedAt) result.coverage = 'partial';
    let remaining = THREAD_TIMELINE_LIMITS.digestRevisions;
    const prior = new Map<string, Item | null>();
    const completedPlanSteps = new Set<string>();
    for (const row of rows) {
      const turn = TurnRecordSchema.parse({ ...row.record, items: [] });
      const terminal = ['completed', 'failed', 'interrupted', 'cancelled'].includes(turn.status);
      // B can be inside a run that completes later without publishing another message.
      if (
        terminal &&
        (!boundary ||
          row.admissionOrder > boundary.admissionOrder ||
          (!!turn.completedAt && !!boundaryCreatedAt && turn.completedAt > boundaryCreatedAt))
      ) {
        add('runs-finished', turn.id, { kind: 'turn', turnId: turn.id });
        if (turn.status === 'failed') add('problems', turn.id, { kind: 'turn', turnId: turn.id });
      }
      let position = boundary?.turnId === turn.id ? boundary.sequence : 0;
      const head = snapshot.revisionHead(turn.id);
      while (remaining > 0 && position < head) {
        const page = snapshot.revisions(turn.id, position, Math.min(64, remaining));
        if (!page.length) break;
        remaining -= page.length;
        for (const entry of page) {
          position = entry.sequence;
          const item = entry.item;
          if (!item) {
            result.coverage = 'partial';
            continue;
          }
          if (!isThreadItemSourceAllowed(item, owner)) continue;
          const anchor = { kind: 'item' as const, itemId: item.id };
          let previous = prior.get(item.id);
          if (!prior.has(item.id) && entry.revision > 1)
            previous = snapshot.revision(turn.id, item.id, entry.revision - 1);
          prior.set(item.id, item);
          if (entry.revision > 1 && !previous) {
            result.coverage = 'partial';
            continue;
          }
          if (
            (item.type === 'assistant-message' || item.type === 'user-message') &&
            item.status === 'completed' &&
            previous?.status !== 'completed'
          )
            add('new-messages', item.id, anchor);
          if (
            (isRecordedItemFailure(item) && (!previous || !isRecordedItemFailure(previous))) ||
            (item.type === 'status' &&
              item.level === 'error' &&
              !(previous?.type === 'status' && previous.level === 'error'))
          )
            add('problems', item.id, anchor);
          if (item.type === 'plan') {
            const old = previous?.type === 'plan' ? previous.steps : [];
            let finished = 0;
            for (const step of item.steps) {
              const key = `${turn.id}:${item.id}:${step.id}`;
              if (
                step.status === 'completed' &&
                !completedPlanSteps.has(key) &&
                !old.some((before) => before.id === step.id && before.status === 'completed')
              ) {
                completedPlanSteps.add(key);
                finished++;
              }
            }
            // A plan can finish further steps in more than one retained revision.
            add('plan-steps-finished', `${item.id}:${entry.sequence}`, anchor, finished);
          }
          if (
            item.type === 'approval-decision' &&
            auditAllowed &&
            entry.revision === 1 &&
            item.actor.kind === 'user' &&
            item.actor.id !== owner.actor.userId
          )
            add('decisions-by-others', item.id, anchor);
          if (item.type === 'artifact-reference' && entry.revision === 1) {
            const review = reviews.get(`${turn.id}:${item.artifactId}:${item.artifactVersion}`);
            if (review) add('needs-you', review, { kind: 'attention', rowId: review });
            const artifact = owner.store.getArtifact(owner.input.workspaceId, item.artifactId);
            if (
              artifact.status === 'ready' &&
              artifact.version === item.artifactVersion &&
              artifact.threadId === owner.input.threadId &&
              artifact.origin.kind === 'turn-output' &&
              !(
                workspaceDb &&
                hasWorkspaceReviewArtifact(workspaceDb, owner.input.workspaceId, artifact.id)
              )
            )
              add('outputs', `${artifact.id}:${artifact.version}`, anchor);
          }
        }
      }
      if (position < head) result.coverage = 'partial';
    }
    const order: Kind[] = [
      'needs-you',
      'runs-finished',
      'outputs',
      'plan-steps-finished',
      'problems',
      'decisions-by-others',
      'new-messages',
    ];
    result.lines = order.flatMap((kind) => (lines.has(kind) ? [lines.get(kind)!] : []));
    return result;
  } finally {
    workspaceDb?.sqlite.close();
  }
}
