import { createMemo, createSignal, For, Show } from 'solid-js';

import type { Thread, WorkspaceSummary } from '../lib/app-types';

/**
 * Props for the collapsible workspace thread list.
 */
export interface ThreadListProps {
  collapsed: boolean;
  isCreating: boolean;
  selectedWorkspaceId: string | null;
  selectedThreadId: string | null;
  showCreateForm: boolean;
  threads: Thread[];
  workspace: WorkspaceSummary;
  onCreateThread(workspaceId: string, title: string): Promise<void>;
  onOpenThread(threadId: string): void;
  onOpenWorkspace(workspaceId: string): void;
  onToggle(workspaceId: string): void;
}

/**
 * Renders one local Remix Icon through the Iconify web component.
 */
function RemixIcon(props: { icon: string }) {
  return (
    <span aria-hidden="true" class="remix-icon">
      <iconify-icon icon={props.icon} />
    </span>
  );
}

/**
 * Returns a badge class for workspace status values rendered in the sidebar.
 */
function workspaceStatusBadgeClass(status: WorkspaceSummary['status']): string {
  return status === 'active' ? 'badge-success' : 'badge-neutral';
}

/**
 * Renders a workspace row with nested thread navigation and thread creation.
 */
export function ThreadList(props: ThreadListProps) {
  const [threadTitleDraft, setThreadTitleDraft] = createSignal('');
  const canCreateThread = createMemo(
    () => threadTitleDraft().trim().length > 0 && !props.isCreating
  );
  const canToggleThreads = createMemo(
    () => props.threads.length > 0 || props.workspace.counts.threadCount > 0
  );

  /**
   * Creates one thread in this workspace from the nested sidebar form.
   */
  async function submitThread(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const title = threadTitleDraft().trim();

    if (!title) {
      return;
    }

    try {
      await props.onCreateThread(props.workspace.id, title);
      setThreadTitleDraft('');
    } catch {
      return;
    }
  }

  return (
    <article class="workspace-nav-group">
      <div class="workspace-nav-row">
        <button
          class={`workspace-card workspace-card-dashboard ${
            props.workspace.id === props.selectedWorkspaceId ? 'workspace-card-active' : ''
          }`}
          onClick={() => props.onOpenWorkspace(props.workspace.id)}
          type="button"
        >
          <span class="flex min-w-0 flex-col text-left">
            <span class="break-words font-semibold text-base-content">{props.workspace.name}</span>
            <span class="text-xs uppercase tracking-[0.18em] opacity-60">
              {props.workspace.counts.threadCount} threads
            </span>
          </span>
          <span
            class={`badge badge-sm shrink-0 ${workspaceStatusBadgeClass(props.workspace.status)}`}
          >
            {props.workspace.status}
          </span>
        </button>
        <Show when={canToggleThreads()}>
          <button
            aria-label={props.collapsed ? 'Expand workspace threads' : 'Collapse workspace threads'}
            class="icon-button workspace-collapse-button"
            onClick={() => props.onToggle(props.workspace.id)}
            type="button"
          >
            <RemixIcon icon={props.collapsed ? 'ri:arrow-right-s-line' : 'ri:arrow-down-s-line'} />
          </button>
        </Show>
      </div>
      <Show when={!props.collapsed}>
        <nav
          aria-label={`Workspace threads in ${props.workspace.name}`}
          class="sidebar-thread-list workspace-thread-nest"
        >
          <Show
            when={props.threads.length > 0}
            fallback={<div class="empty-state">No threads yet.</div>}
          >
            <For each={props.threads}>
              {(thread) => (
                <button
                  class={`thread-card thread-card-stacked thread-card-nested ${
                    thread.id === props.selectedThreadId ? 'thread-card-active' : ''
                  }`}
                  onClick={() => props.onOpenThread(thread.id)}
                  type="button"
                >
                  <span class="min-w-0 break-words font-semibold text-base-content">
                    {thread.name ?? 'Untitled'}
                  </span>
                  <span class="min-w-0 break-words text-sm opacity-70">{thread.preview}</span>
                </button>
              )}
            </For>
          </Show>
          <Show when={props.showCreateForm}>
            <form class="grid gap-2" onSubmit={(event) => void submitThread(event)}>
              <label class="sr-only" for={`new-thread-${props.workspace.id}`}>
                New thread for {props.workspace.name}
              </label>
              <input
                id={`new-thread-${props.workspace.id}`}
                class="input input-bordered input-sm"
                name="threadTitle"
                value={threadTitleDraft()}
                onInput={(event) => setThreadTitleDraft(event.currentTarget.value)}
                placeholder="New thread"
              />
              <button class="btn btn-neutral btn-sm" disabled={!canCreateThread()} type="submit">
                New thread
              </button>
            </form>
          </Show>
        </nav>
      </Show>
    </article>
  );
}
