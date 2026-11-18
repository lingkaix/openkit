import { type ActorRef, deriveEntityId } from '@openkit/protocol';

/** Derives the provider Chat Turn identity from its exact command scope, excluding private input. */
export function providerChatTurnId(
  actor: ActorRef,
  workspaceId: string,
  threadId: string,
  requestId: string
): string {
  return deriveEntityId('tu', {
    command: 'conversation.submit',
    actor,
    workspaceId,
    threadId,
    requestId,
  });
}

/** Derives the receiving Thread of an admitted command-initiated conversation handoff. */
export function conversationTaskThreadId(
  actor: ActorRef,
  workspaceId: string,
  originatingThreadId: string,
  requestId: string
): string {
  return deriveEntityId('th', [actor, workspaceId, originatingThreadId, requestId]);
}

/** Derives the first Task Turn inside that handoff's exact receiving Thread. */
export function conversationTaskTurnId(
  actor: ActorRef,
  workspaceId: string,
  originatingThreadId: string,
  receivingThreadId: string,
  requestId: string
): string {
  return deriveEntityId('tu', [
    actor,
    workspaceId,
    originatingThreadId,
    receivingThreadId,
    requestId,
  ]);
}
