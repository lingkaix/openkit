import type { FsStore } from '../lib/store.js';
import { raiseRecordedPendingRequest } from '../runtime/pending-request-flow.js';
import type { RaisePendingRequestInput } from '../runtime/pending-requests.js';
import type { prepareDiscordPublication } from './discord-publication-intent.js';

type PublicationProposal = Extract<
  ReturnType<typeof prepareDiscordPublication>,
  { kind: 'proposal' }
>;

/** Ruling 6A fallback writer. It cannot send, consume an approval, or select a recipient. */
export async function raiseDiscordPublicationFallback(input: {
  readonly store: FsStore;
  readonly sqlite: Parameters<typeof raiseRecordedPendingRequest>[1];
  readonly proposal: PublicationProposal;
  readonly request: Pick<
    RaisePendingRequestInput,
    | 'requestId'
    | 'requestItemId'
    | 'workspaceId'
    | 'threadId'
    | 'raisingTurnId'
    | 'responsibleUserId'
    | 'now'
  >;
  /** Resolves the current digest, source, and accountable member in the owning command. */
  readonly stillAuthorized: () => boolean;
}) {
  if (!input.stillAuthorized()) return undefined;
  return raiseRecordedPendingRequest(input.store, input.sqlite, {
    ...input.request,
    kind: 'approval',
    requesterKind: 'person',
    governedIntent: input.proposal.governedIntent,
    approval: {
      kind: 'permission',
      title: 'Publish this answer to Discord?',
      description: 'Open the exact Discord publication preview in the App.',
    },
  });
}
