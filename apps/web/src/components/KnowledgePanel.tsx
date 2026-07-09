import { createMemo, createSignal, For, Show } from 'solid-js';

import type { KnowledgeEntry } from '../lib/app-types';

/**
 * Input used to create a workspace knowledge entry.
 */
export type CreateKnowledgeInput = Pick<KnowledgeEntry, 'kind' | 'title' | 'content'>;

/**
 * Input used to update a workspace knowledge entry.
 */
export type UpdateKnowledgeInput = Partial<Pick<KnowledgeEntry, 'title' | 'content'>>;

/**
 * Props for the workspace knowledge editing panel.
 */
export interface KnowledgePanelProps {
  entries: KnowledgeEntry[];
  errorMessage: string | null;
  isSaving: boolean;
  onCreate(input: CreateKnowledgeInput): Promise<void>;
  onDelete(knowledgeEntryId: string): Promise<void>;
  onUpdate(knowledgeEntryId: string, input: UpdateKnowledgeInput): Promise<void>;
}

/**
 * Renders workspace-scoped knowledge entries with create and inline edit controls.
 */
export function KnowledgePanel(props: KnowledgePanelProps) {
  const [knowledgeKindDraft, setKnowledgeKindDraft] =
    createSignal<KnowledgeEntry['kind']>('project-context');
  const [knowledgeTitleDraft, setKnowledgeTitleDraft] = createSignal('');
  const [knowledgeContentDraft, setKnowledgeContentDraft] = createSignal('');
  const [editingKnowledgeId, setEditingKnowledgeId] = createSignal<string | null>(null);
  const canSubmitKnowledge = createMemo(
    () =>
      knowledgeTitleDraft().trim().length > 0 &&
      knowledgeContentDraft().trim().length > 0 &&
      !props.isSaving
  );

  /**
   * Resets the knowledge editor to create mode.
   */
  function resetKnowledgeEditor(): void {
    setEditingKnowledgeId(null);
    setKnowledgeKindDraft('project-context');
    setKnowledgeTitleDraft('');
    setKnowledgeContentDraft('');
  }

  /**
   * Loads one knowledge entry into the editor for inline editing.
   */
  function startKnowledgeEdit(knowledgeEntry: KnowledgeEntry): void {
    setEditingKnowledgeId(knowledgeEntry.id);
    setKnowledgeKindDraft(knowledgeEntry.kind);
    setKnowledgeTitleDraft(knowledgeEntry.title);
    setKnowledgeContentDraft(knowledgeEntry.content);
  }

  /**
   * Creates or updates one workspace knowledge entry from the current form draft.
   */
  async function submitKnowledge(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const knowledgeEntryId = editingKnowledgeId();

    try {
      if (knowledgeEntryId) {
        await props.onUpdate(knowledgeEntryId, {
          title: knowledgeTitleDraft().trim(),
          content: knowledgeContentDraft().trim(),
        });
      } else {
        await props.onCreate({
          kind: knowledgeKindDraft(),
          title: knowledgeTitleDraft().trim(),
          content: knowledgeContentDraft().trim(),
        });
      }

      resetKnowledgeEditor();
    } catch {
      return;
    }
  }

  /**
   * Deletes one workspace knowledge entry.
   */
  async function deleteKnowledge(knowledgeEntryId: string): Promise<void> {
    try {
      await props.onDelete(knowledgeEntryId);

      if (editingKnowledgeId() === knowledgeEntryId) {
        resetKnowledgeEditor();
      }
    } catch {
      return;
    }
  }

  return (
    <section class="settings-content-panel">
      <div class="ui-section-header mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 class="font-display text-xl font-semibold">Knowledge</h3>
        <span class="badge badge-outline">{props.entries.length}</span>
      </div>

      <div class="grid gap-4">
        <form class="support-card space-y-3" onSubmit={(event) => void submitKnowledge(event)}>
          <label class="form-control ui-field">
            <span class="label-text">Knowledge kind</span>
            <select
              class="select select-bordered"
              disabled={editingKnowledgeId() !== null}
              name="knowledgeKind"
              value={knowledgeKindDraft()}
              onChange={(event) =>
                setKnowledgeKindDraft(event.currentTarget.value as KnowledgeEntry['kind'])
              }
            >
              <option value="project-context">project-context</option>
              <option value="preference">preference</option>
              <option value="task-summary">task-summary</option>
            </select>
          </label>

          <label class="form-control ui-field">
            <span class="label-text">Knowledge title</span>
            <input
              class="input input-bordered"
              name="knowledgeTitle"
              value={knowledgeTitleDraft()}
              onInput={(event) => setKnowledgeTitleDraft(event.currentTarget.value)}
            />
          </label>

          <label class="form-control ui-field">
            <span class="label-text">Knowledge content</span>
            <textarea
              class="textarea textarea-bordered min-h-28"
              name="knowledgeContent"
              value={knowledgeContentDraft()}
              onInput={(event) => setKnowledgeContentDraft(event.currentTarget.value)}
            />
          </label>

          <Show when={props.errorMessage}>
            {(message) => <div class="alert alert-error text-sm">{message()}</div>}
          </Show>

          <div class="flex gap-2">
            <button class="btn btn-primary flex-1" disabled={!canSubmitKnowledge()} type="submit">
              {editingKnowledgeId() ? 'Save knowledge' : 'Add knowledge'}
            </button>
            <Show when={editingKnowledgeId()}>
              <button class="btn btn-ghost" onClick={resetKnowledgeEditor} type="button">
                Cancel
              </button>
            </Show>
          </div>
        </form>

        <div class="grid gap-3">
          <Show
            when={props.entries.length > 0}
            fallback={<div class="empty-state">No knowledge entries yet.</div>}
          >
            <For each={props.entries}>
              {(knowledgeEntry) => (
                <article class="support-card">
                  <div class="flex items-start justify-between gap-3">
                    <div>
                      <div class="flex items-center gap-2">
                        <h4 class="font-semibold">{knowledgeEntry.title}</h4>
                        <span class="badge badge-outline badge-xs">{knowledgeEntry.kind}</span>
                      </div>
                      <p class="mt-2 text-sm leading-6 opacity-80">{knowledgeEntry.content}</p>
                    </div>
                    <div class="flex shrink-0 flex-wrap justify-end gap-2">
                      <button
                        aria-label={`Edit ${knowledgeEntry.title}`}
                        class="btn btn-ghost btn-xs"
                        onClick={() => startKnowledgeEdit(knowledgeEntry)}
                        type="button"
                      >
                        Edit
                      </button>
                      <button
                        aria-label={`Delete ${knowledgeEntry.title}`}
                        class="btn btn-outline btn-xs"
                        disabled={props.isSaving}
                        onClick={() => void deleteKnowledge(knowledgeEntry.id)}
                        type="button"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </article>
              )}
            </For>
          </Show>
        </div>
      </div>
    </section>
  );
}
