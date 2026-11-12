import {
  ArtifactReviewViewSchema,
  ListHumanAttentionResponseSchema,
  ThreadTimelineResponseSchema,
  type TimelineItem,
  type TimelineRunEntry,
} from '@openkit/app-api-schemas';
import { ArtifactSchema, allocateEntityId, type Item, ItemSchema } from '@openkit/protocol';

/** Schema-checked API read projections. These fixtures do not write durable records. */
export function tw8Fixture(
  workspaceId = allocateEntityId('ws'),
  threadId = allocateEntityId('th')
) {
  const userId = allocateEntityId('usr');
  const turnId = allocateEntityId('tu');
  const artifactId = allocateEntityId('ar');
  const at = new Date(Date.now() - 60_000).toISOString();
  const thread = {
    id: threadId,
    owner: { kind: 'workspace' as const, workspaceId },
    name: 'Launch notes',
    preview: '',
    status: 'active' as const,
    visibility: 'workspace' as const,
    entryPath: 'conversation' as const,
    createdAt: at,
    updatedAt: at,
  };
  const old = ArtifactSchema.parse({
    id: artifactId,
    workspaceId,
    threadId,
    turnId,
    kind: 'report',
    title: 'Timeline report',
    summary: null,
    status: 'ready',
    version: 1,
    content: { format: 'markdown', body: 'Exact retained output version one' },
    contentDigest: `sha256:${'a'.repeat(64)}`,
    lastMutationRequestId: 'version-one',
    origin: { kind: 'turn-output', threadId, turnId, requestId: 'version-one' },
    createdAt: at,
    updatedAt: at,
  });
  const head = ArtifactSchema.parse({
    ...old,
    version: 3,
    content: { format: 'markdown', body: 'Current head output version three' },
    contentDigest: `sha256:${'c'.repeat(64)}`,
    lastMutationRequestId: 'version-three',
  });
  function version(artifact: typeof old) {
    return {
      workspaceId,
      artifactId,
      artifactVersion: artifact.version,
      parentVersion: artifact.version === 1 ? null : artifact.version - 1,
      contentDigest: artifact.contentDigest,
      title: artifact.title,
      summary: artifact.summary,
      actor: { kind: 'user' as const, id: userId },
      threadId,
      turnId,
      requestId: artifact.lastMutationRequestId,
      recordedAt: at,
    };
  }
  function reference() {
    const result = ItemSchema.parse({
      id: allocateEntityId('it'),
      owner: { kind: 'workspace', workspaceId },
      threadId,
      turnId,
      type: 'artifact-reference',
      status: 'completed',
      artifactId,
      artifactVersion: 1,
      lastMutationRequestId: 'version-one',
      title: 'Timeline report',
      summary: null,
      createdAt: at,
      completedAt: at,
    });
    if (result.type !== 'artifact-reference') throw new Error('Expected reference fixture.');
    return result;
  }
  const oldReview = ArtifactReviewViewSchema.parse({
    workspaceId,
    reviewId: allocateEntityId('arev'),
    artifactId,
    artifactVersion: 1,
    contentDigest: old.contentDigest,
    sourceThreadId: threadId,
    sourceTurnId: turnId,
    sourceAgentId: null,
    materialProposal: null,
    decision: 'accepted',
    decisionActorId: userId,
    feedback: 'Exact earlier review evidence',
    decidedAt: at,
    followUpTurnId: null,
    appliedMaterialRevisionId: null,
    createdAt: at,
  });
  const pendingReview = ArtifactReviewViewSchema.parse({
    ...oldReview,
    reviewId: allocateEntityId('arev'),
    artifactVersion: 3,
    contentDigest: head.contentDigest,
    decision: null,
    decisionActorId: null,
    feedback: null,
    decidedAt: null,
  });
  function navigation(ids = [threadId]) {
    return {
      items: ids.map((id, index) => ({
        thread: { ...thread, id, name: id === threadId ? thread.name : `Lane ${index + 1}` },
        activity: 'chat' as const,
        state: 'idle' as const,
        lastActivityAt: at,
        unreadCount: 0,
      })),
    };
  }
  function attention(id: string, sourceThreadId = threadId, title = 'Approve the report') {
    const itemId = allocateEntityId('it');
    const sourceTurnId = sourceThreadId === threadId ? turnId : allocateEntityId('tu');
    return ListHumanAttentionResponseSchema.parse({
      items: [
        {
          id: `approval:${id}`,
          kind: 'approval',
          workspaceId,
          threadId: sourceThreadId,
          turnId: sourceTurnId,
          itemId,
          title,
          summary: 'A decision is waiting.',
          severity: 'needs_input',
          createdAt: at,
          ageSeconds: 0,
          blocking: true,
          source: {
            type: 'approval',
            approvalRequestId: id,
            workspaceId,
            threadId: sourceThreadId,
            turnId: sourceTurnId,
            itemId,
          },
          actions: [
            { kind: 'grant_approval', label: 'Approve', method: 'POST' },
            { kind: 'deny_approval', label: 'Deny', method: 'POST' },
          ],
        },
      ],
    }).items[0]!;
  }
  function message(runId: string, text: string) {
    return ItemSchema.parse({
      id: allocateEntityId('it'),
      owner: { kind: 'workspace', workspaceId },
      threadId,
      turnId: runId,
      type: 'user-message',
      actor: { kind: 'user', id: userId },
      status: 'completed',
      text,
      createdAt: at,
      completedAt: at,
    });
  }
  function detail(item: Item): TimelineItem {
    return {
      id: item.id,
      turnId: item.turnId,
      type: item.type,
      placement: 'narrative',
      status: item.status,
      createdAt: item.createdAt,
      completedAt: item.completedAt ?? null,
      actor: 'actor' in item ? (item.actor ?? null) : null,
      detail: { kind: 'complete', value: item },
      steer: null,
    };
  }
  function run(order: number, id: string, text: string): TimelineRunEntry {
    return {
      id,
      admissionOrder: order,
      status: 'completed',
      triggerActor: { kind: 'user', id: userId },
      agentId: null,
      triggerSource: null,
      startedAt: at,
      completedAt: at,
      durationMs: 1000,
      error: null,
      long: false,
      narrative: [detail(message(id, text))],
      plan: null,
      noteItemIds: [],
      finalItemId: null,
      narrativeCursor: null,
      statistics: {
        steps: 0,
        failedStepCount: 0,
        failedCommandCount: 0,
        filesChanged: 0,
        messages: 1,
        itemCounts: {},
        coverage: 'complete',
      },
      interruptedBy: { visibility: 'available', actor: null },
      restrictedReferences: false,
    };
  }
  function page(runs: TimelineRunEntry[], anchor: { turnId: string } | null = null) {
    return ThreadTimelineResponseSchema.parse({
      workspaceId,
      threadId,
      view: 'runs',
      runs,
      items: [],
      beforeCursor: null,
      afterCursor: null,
      anchor,
      catchUpAnchor: null,
      itemWindow: null,
      digest: { lines: [], coverage: 'complete' },
      restrictedReferences: false,
    });
  }
  const workspaceList = {
    items: [
      {
        workspace: { id: workspaceId, name: 'Test Workspace', kind: 'code' },
        membershipStatus: 'active',
        accessCause: 'membership',
        isOwner: true,
        effectiveRole: 'owner',
        ownerUserId: userId,
        membershipRevision: 1,
        registryRevision: 1,
      },
    ],
  };
  return {
    workspaceId,
    threadId,
    userId,
    turnId,
    artifactId,
    at,
    thread,
    old,
    head,
    version,
    reference,
    oldReview,
    pendingReview,
    navigation,
    attention,
    message,
    run,
    page,
    workspaceList,
  };
}
