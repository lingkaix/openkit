import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConnection } from '../../app/core-client';
import {
  Composer,
  type ComposerDraft,
  ContextChip,
  EmptyState,
  ErrorBanner,
  ListRow,
  Skeleton,
} from '../../primitives';
import { createRequestId, useArtifacts, useImportWorkspaceArtifact } from '../artifacts/data';
import {
  chatThreadPath,
  taskThreadPath,
  useConversationTargets,
  useCreateThread,
  useCurrentWorkspaceId,
  useThreads,
} from './data';

/**
 * Chat starter (WP-4, board 01) — the usable workbench first screen.
 *
 * Composer-first: describe what you need and a thread opens. Recent threads sit
 * below for quick re-entry. No landing page (DESIGN.md §1). Honors the §9.13
 * states: skeleton while recent threads load, a calm empty block on first use, an
 * inline banner if creating a chat fails, and a disabled composer with a stated
 * reason when the runtime is unreachable.
 */
export function ChatStarter() {
  const navigate = useNavigate();
  const workspaceId = useCurrentWorkspaceId();
  const threads = useThreads(workspaceId);
  const targets = useConversationTargets(workspaceId);
  const artifacts = useArtifacts(workspaceId);
  const importArtifact = useImportWorkspaceArtifact();
  const create = useCreateThread();
  const { failed: disconnected } = useConnection();
  const createOwner = create.variables?.workspaceId === workspaceId;
  const activeThreads = (threads.data ?? []).filter((thread) => thread.status === 'active');

  useEffect(() => {
    if (!createOwner || !create.data) return;
    const path =
      create.data.receivingThreadId === create.data.originatingThreadId
        ? chatThreadPath(create.data.receivingWorkspaceId, create.data.receivingThreadId)
        : taskThreadPath(create.data.receivingWorkspaceId, create.data.receivingThreadId);
    navigate(path);
  }, [create.data, createOwner, navigate]);

  /**
   * Starts a chat in the current workspace.
   *
   * @param message - The submitted first message.
   */
  function start(draft: ComposerDraft) {
    if (!workspaceId) return;
    return create.mutateAsync({ workspaceId, draft });
  }

  async function importFile(file: File) {
    if (!workspaceId) throw new Error('Workspace is required.');
    const mediaType = file.name.endsWith('.md')
      ? 'text/markdown'
      : file.name.endsWith('.json')
        ? 'application/json'
        : 'text/plain';
    const imported = await importArtifact.mutateAsync({
      workspaceId,
      title: file.name,
      mediaType,
      content: await file.text(),
      requestId: createRequestId(),
    });
    void artifacts.refetch();
    return { id: imported.artifactId, version: imported.artifactVersion, label: file.name };
  }

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6 px-6 py-10">
      <div>
        <h1 className="text-title font-extrabold text-fg-strong">What can we get done?</h1>
        <p className="mt-1 text-fg-muted">
          Describe what you need — from a quick question to a whole project.
        </p>
      </div>

      {createOwner && create.isError ? (
        <ErrorBanner
          message="Couldn't start that chat. Try again."
          onRetry={() => create.reset()}
        />
      ) : null}

      <Composer
        size="starter"
        chips={<ContextChip>New chat</ContextChip>}
        targetCatalog={targets.data ?? null}
        artifacts={(artifacts.data ?? []).map((artifact) => ({
          id: artifact.id,
          version: artifact.version,
          label: artifact.title,
        }))}
        onImportFile={importFile}
        disabledReason={
          disconnected
            ? "Couldn't reach the local runtime."
            : targets.isError
              ? "Couldn't load conversation agents."
              : undefined
        }
        onSubmit={start}
      />

      <section className="flex flex-col gap-2">
        <p className="text-eyebrow font-bold uppercase tracking-eyebrow text-fg-muted">Recent</p>
        {threads.isLoading ? (
          <Skeleton lines={3} />
        ) : threads.isError ? (
          <ErrorBanner
            message="Couldn't load recent chats."
            onRetry={() => void threads.refetch()}
          />
        ) : activeThreads.length === 0 ? (
          <EmptyState
            icon="chat"
            title="Start a chat"
            hint="Your recent chats will show up here."
          />
        ) : (
          activeThreads.map((thread) => (
            <ListRow key={thread.id}>
              <button
                type="button"
                onClick={() => navigate(chatThreadPath(thread.workspaceId, thread.id))}
                className="flex min-w-0 flex-1 items-center gap-3 rounded-ok px-2 py-1 text-left outline-none hover:bg-overlay focus-visible:ring-2 focus-visible:ring-focus"
              >
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
                  {thread.name ?? thread.preview}
                </span>
              </button>
            </ListRow>
          ))
        )}
      </section>
    </div>
  );
}
