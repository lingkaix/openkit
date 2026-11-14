import { createHash } from 'node:crypto';
import { deriveEntityId } from '@openkit/protocol';
import type { Actor } from '../auth/identity.js';
import { isCurrentDeploymentAdministrator } from '../auth/operation-authorizer.js';
import { isThreadVisible } from '../auth/thread-visibility.js';
import type { FsStore } from '../lib/store.js';
import { OperationError } from '../operation-error.js';
import type { CoreDb } from '../storage/db.js';

/** Creates only a local unsubmitted draft after the public entry admits the actual person/source. */
export async function preparePrivateReportDraft(input: {
  readonly coreDb: CoreDb;
  readonly store: FsStore;
  readonly actor: Actor;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly requestId: string;
  readonly sourceRequestId: string;
  readonly description: string;
  readonly signal?: AbortSignal;
}) {
  const { store, workspaceId, threadId, actor, requestId } = input;
  const turnId = deriveEntityId('tu', [
    'operator-private-report',
    actor.userId,
    workspaceId,
    threadId,
    requestId,
  ]);
  const artifactId = deriveEntityId('ar', [
    'operator-private-report',
    actor.userId,
    workspaceId,
    threadId,
    requestId,
  ]);
  const assertPrivate = () => {
    input.signal?.throwIfAborted();
    const administrator = isCurrentDeploymentAdministrator(input.coreDb, actor);
    const thread = store.getThread(workspaceId, threadId);
    if (
      !administrator ||
      actor.kind === 'token' ||
      thread.entryPath !== 'administration' ||
      thread.visibility !== 'private' ||
      thread.privateOwnerUserId !== actor.userId ||
      thread.status !== 'active' ||
      !isThreadVisible(store, thread, actor.userId, administrator, 'artifact.write')
    )
      throw new OperationError(
        'not_granted',
        'The current private draft audience is unavailable.',
        403
      );
  };
  const quoted = JSON.stringify(Array.from(input.description).slice(0, 1200).join(''));
  const body = [
    '# Private operator report draft',
    'Local, unsubmitted and unverified. Submit privately only after personal review: https://github.com/lingkaix/openkit/security',
    'The human authorized preparation, not proof of human sole authorship or review. Original external influence and audience restrictions remain.',
    `Source alarm context: ${input.sourceRequestId}. This is not a finding identity or permission.`,
    'Untrusted human observations (JSON-quoted, limited/truncated to 1200 Unicode codepoints):',
    quoted,
    'No automatic submission, Task, issue, PR, credentials or binding creation.',
  ].join('\n\n');
  const createdAt = new Date().toISOString();
  let created = false;
  try {
    assertPrivate();
    await store.createTurn(
      workspaceId,
      threadId,
      'Prepare a local private report draft',
      { kind: 'user', id: actor.userId },
      null,
      {
        turnId,
        agentId: null,
        agentSessionId: null,
        executorKind: 'person',
        externallyInfluenced: true,
        triggerSource: {
          kind: 'user-input',
          summary: 'Person requested a local private report draft.',
        },
      }
    );
    created = true;
    assertPrivate();
    const artifact = await store.createArtifact({
      id: artifactId,
      workspaceId,
      threadId,
      turnId,
      kind: 'report',
      title: 'Private operator draft — unsubmitted and unverified',
      status: 'draft',
      summary: 'Local draft only; inspect the producing Turn for preparation status.',
      version: 1,
      content: { format: 'markdown', body },
      contentDigest: `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`,
      origin: { kind: 'turn-output', threadId, turnId, requestId },
      lastMutationRequestId: requestId,
      createdAt,
      updatedAt: createdAt,
    });
    assertPrivate();
    await store.completeTurn(turnId, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      error: null,
    });
    return {
      artifactId: artifact.id,
      artifactVersion: 1 as const,
      contentDigest: artifact.contentDigest,
      turnId,
    };
  } catch (error) {
    // Preserve all original partial authority. This is an error close, never a replay or repair.
    if (created) {
      try {
        const current = store.getTurn(workspaceId, threadId, turnId);
        if (!['completed', 'failed', 'interrupted', 'cancelled'].includes(current.status)) {
          await store.completeTurn(turnId, {
            status:
              error instanceof Error && error.name === 'AbortError' ? 'interrupted' : 'failed',
            completedAt: new Date().toISOString(),
            error: null,
          });
        }
      } catch {
        // A failed/unknown native owner cannot prove noncommit; retain it for inspection.
      }
    }
    throw new OperationError(
      'security_report_unavailable',
      'Private draft preparation could not be confirmed. Inspect its original private Turn; only an explicit new draft is a new attempt.',
      503,
      { cause: error }
    );
  }
}
