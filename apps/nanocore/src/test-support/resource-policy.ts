import type { PolicyDocumentV1 } from '@openkit/protocol';

/** Produces a current-format managed Thread fixture without supplying runtime authority. */
export function managedThreadPolicy(input: {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly operations?: readonly string[];
  readonly agentId?: string;
}): PolicyDocumentV1 {
  const owner = { kind: 'workspace' as const, workspaceId: input.workspaceId };
  const envelope = {
    author: { kind: 'human' as const, id: input.userId },
    authority: { kind: 'human' as const, userId: input.userId },
    authoredAt: '2026-10-19T00:00:00.000Z',
    state: 'active' as const,
    lifetime: { anchor: { owner, kind: 'workspace', id: input.workspaceId } },
  };
  const resources = [
    { kind: 'container' as const, container: { owner, kind: 'thread', id: input.threadId } },
  ];
  const statements: PolicyDocumentV1['statements'] = [
    {
      ...envelope,
      id: `boundary-${input.threadId}`,
      kind: 'managed-boundary',
      scope: { subjects: [], actions: [], resources },
    },
  ];
  if (input.operations?.length)
    statements.push({
      ...envelope,
      id: `permission-${input.threadId}`,
      kind: 'permission',
      scope: {
        subjects: [{ kind: 'human', id: input.userId }],
        actions: [...input.operations],
        resources,
      },
      effect: 'allow',
      grant: input.agentId
        ? { kind: 'agent-process', agentId: input.agentId }
        : { kind: 'ordinary' },
    });
  return { schemaVersion: 1, statements };
}
