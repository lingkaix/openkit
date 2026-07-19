import { createMemo, For, type JSX, Show } from 'solid-js';

declare module 'solid-js' {
  namespace JSX {
    interface IntrinsicElements {
      'iconify-icon': {
        class?: string;
        icon: string;
      };
    }
  }
}

export type ChatComposerMode = 'agent' | 'quick';

export interface ChatComposerWorkspaceOption {
  id: string;
  name: string;
}

export interface ChatComposerModelOption {
  enabled: boolean;
  id: string;
  name: string;
}

/** Composer submission normalized to the authority of the selected mode. */
export type ChatComposerSubmitInput =
  | {
      input: string;
      mode: 'agent';
      modelId: string | null;
      workspaceId: string;
    }
  | {
      input: string;
      mode: 'quick';
      workspaceId: string;
    };

export interface ChatComposerProps {
  ariaLabel: string;
  canSubmit: boolean;
  inputLabel: string;
  isSubmitting: boolean;
  mode: ChatComposerMode;
  models: ChatComposerModelOption[];
  placeholder: string;
  selectedModelId: string | null;
  selectedWorkspaceId: string | null;
  submitLabel: string;
  value: string;
  workspaceLocked: boolean;
  workspaces: ChatComposerWorkspaceOption[];
  onInput(value: string): void;
  onModelChange(modelId: string | null): void;
  onModeChange?(mode: ChatComposerMode): void;
  onSubmit(input: ChatComposerSubmitInput): void;
  onWorkspaceChange?(workspaceId: string): void;
  quickChatDisabledMessage?: string;
  quickChatEnabled?: boolean;
}

/**
 * Renders one local Remix Icon through the Iconify web component.
 */
function RemixIcon(props: { icon: string }): JSX.Element {
  return (
    <span aria-hidden="true" class="remix-icon">
      <iconify-icon icon={props.icon} />
    </span>
  );
}

/**
 * Renders the shared chat composer used by the starter and thread turn surfaces.
 *
 * @param props Composer state, options, and event handlers.
 * @returns Shared composer form.
 */
export function ChatComposer(props: ChatComposerProps): JSX.Element {
  const selectedWorkspace = createMemo(
    () =>
      props.workspaces.find((workspace) => workspace.id === props.selectedWorkspaceId) ??
      props.workspaces[0] ??
      null
  );
  const enabledModels = createMemo(() => props.models.filter((model) => model.enabled));
  const selectedModelId = createMemo(
    () => props.selectedModelId ?? enabledModels()[0]?.id ?? props.models[0]?.id ?? null
  );
  const quickChatEnabled = createMemo(() => props.quickChatEnabled ?? true);

  /**
   * Submits the normalized composer payload.
   */
  function submitComposer(event: SubmitEvent): void {
    event.preventDefault();
    const input = props.value.trim();
    const workspaceId = selectedWorkspace()?.id;

    if (!input || !workspaceId || !props.canSubmit) {
      return;
    }

    if (props.mode === 'quick') {
      props.onSubmit({ input, mode: 'quick', workspaceId });
      return;
    }

    props.onSubmit({ input, mode: 'agent', modelId: selectedModelId(), workspaceId });
  }

  return (
    <form aria-label={props.ariaLabel} class="chat-composer-card" onSubmit={submitComposer}>
      <label class="sr-only" for={`${props.ariaLabel.replace(/\s+/g, '-').toLowerCase()}-input`}>
        {props.inputLabel}
      </label>
      <input
        id={`${props.ariaLabel.replace(/\s+/g, '-').toLowerCase()}-input`}
        class="chat-thread-input"
        name="composerInput"
        value={props.value}
        onInput={(event) => props.onInput(event.currentTarget.value)}
        placeholder={props.placeholder}
      />

      <div class="chat-composer-actions">
        <div class="chat-composer-left">
          <button
            aria-label="Add context (not available yet)"
            class="icon-button"
            disabled
            title="Context attachments are not available yet."
            type="button"
          >
            <RemixIcon icon="ri:add-line" />
          </button>
          <fieldset class="chat-mode-toggle">
            <legend class="sr-only">Chat mode</legend>
            <button
              aria-pressed={props.mode === 'agent'}
              class={`chat-mode-button ${props.mode === 'agent' ? 'chat-mode-button-active' : ''}`}
              onClick={() => props.onModeChange?.('agent')}
              type="button"
            >
              Agent chat
            </button>
            <button
              aria-pressed={props.mode === 'quick'}
              class={`chat-mode-button ${props.mode === 'quick' ? 'chat-mode-button-active' : ''}`}
              disabled={!quickChatEnabled()}
              onClick={() => props.onModeChange?.('quick')}
              title={quickChatEnabled() ? 'Use quick chat.' : props.quickChatDisabledMessage}
              type="button"
            >
              Quick chat
            </button>
          </fieldset>
        </div>
        <div class="chat-composer-right">
          <Show when={props.mode === 'agent'}>
            <label
              class="sr-only"
              for={`${props.ariaLabel.replace(/\s+/g, '-').toLowerCase()}-model`}
            >
              Model
            </label>
            <select
              id={`${props.ariaLabel.replace(/\s+/g, '-').toLowerCase()}-model`}
              aria-label="Model"
              class="chat-model-select"
              name="composerModel"
              value={selectedModelId() ?? ''}
              onInput={(event) => props.onModelChange(event.currentTarget.value || null)}
              onChange={(event) => props.onModelChange(event.currentTarget.value || null)}
            >
              <For each={props.models}>
                {(model) => (
                  <option disabled={!model.enabled} value={model.id}>
                    {model.name}
                  </option>
                )}
              </For>
            </select>
          </Show>
          <button
            aria-label="Use voice input (not available yet)"
            class="icon-button"
            disabled
            title="Voice input is not available yet."
            type="button"
          >
            <RemixIcon icon="ri:mic-line" />
          </button>
          <button
            aria-label={props.submitLabel}
            class="icon-button chat-submit-button"
            disabled={!props.canSubmit || props.isSubmitting}
            type="submit"
          >
            <RemixIcon icon="ri:arrow-up-line" />
          </button>
        </div>
      </div>

      <div class="chat-workspace-line">
        <RemixIcon icon="ri:folder-3-line" />
        <Show
          when={!props.workspaceLocked}
          fallback={<span>{selectedWorkspace()?.name ?? 'No workspace selected'}</span>}
        >
          <label
            class="sr-only"
            for={`${props.ariaLabel.replace(/\s+/g, '-').toLowerCase()}-workspace`}
          >
            Workspace
          </label>
          <select
            id={`${props.ariaLabel.replace(/\s+/g, '-').toLowerCase()}-workspace`}
            aria-label="Workspace"
            class="chat-workspace-select"
            name="composerWorkspace"
            value={selectedWorkspace()?.id ?? ''}
            onInput={(event) => props.onWorkspaceChange?.(event.currentTarget.value)}
            onChange={(event) => props.onWorkspaceChange?.(event.currentTarget.value)}
          >
            <For each={props.workspaces}>
              {(workspace) => <option value={workspace.id}>{workspace.name}</option>}
            </For>
          </select>
        </Show>
      </div>
    </form>
  );
}
