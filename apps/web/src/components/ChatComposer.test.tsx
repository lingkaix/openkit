import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, describe, expect, it } from 'vitest';

import { ChatComposer, type ChatComposerMode, type ChatComposerSubmitInput } from './ChatComposer';

const workspaces = [
  { id: 'ws_demo', name: 'Demo Workspace' },
  { id: 'ws_docs', name: 'Docs Workspace' },
];
const models = [
  { id: 'model_codex', name: 'Codex', enabled: true },
  { id: 'model_opencode', name: 'OpenCode', enabled: true },
];

afterEach(() => {
  cleanup();
});

describe('ChatComposer', () => {
  it('submits agent chat with the selected workspace and model', async () => {
    const [draft, setDraft] = createSignal('');
    const [mode, setMode] = createSignal<ChatComposerMode>('agent');
    let submitted: ChatComposerSubmitInput | null = null;

    render(() => (
      <ChatComposer
        ariaLabel="Chat starter"
        canSubmit={true}
        inputLabel="Thread title"
        isSubmitting={false}
        mode={mode()}
        models={models}
        onInput={setDraft}
        onModeChange={setMode}
        onModelChange={() => undefined}
        onSubmit={(input) => {
          submitted = input;
        }}
        onWorkspaceChange={() => undefined}
        placeholder="Ask OpenKit anything."
        selectedModelId="model_opencode"
        selectedWorkspaceId="ws_docs"
        submitLabel="Start thread"
        value={draft()}
        workspaceLocked={false}
        workspaces={workspaces}
      />
    ));

    fireEvent.input(screen.getByRole('textbox', { name: /thread title/i }), {
      target: { value: 'Review protocol state' },
    });
    fireEvent.click(screen.getByRole('button', { name: /start thread/i }));

    expect(submitted).toEqual({
      input: 'Review protocol state',
      mode: 'agent',
      modelId: 'model_opencode',
      workspaceId: 'ws_docs',
    });
  });

  it('locks workspace selection for thread turns', () => {
    render(() => (
      <ChatComposer
        ariaLabel="Turn composer"
        canSubmit={true}
        inputLabel="Turn prompt"
        isSubmitting={false}
        mode="agent"
        models={models}
        onInput={() => undefined}
        onModelChange={() => undefined}
        onSubmit={() => undefined}
        placeholder="Ask a follow-up."
        selectedModelId="model_codex"
        selectedWorkspaceId="ws_demo"
        submitLabel="Send turn"
        value=""
        workspaceLocked={true}
        workspaces={workspaces}
      />
    ));

    expect(screen.queryByRole('combobox', { name: /workspace/i })).toBeNull();
    expect(screen.getByText(/demo workspace/i)).toBeInTheDocument();
  });

  it('submits quick chat without exposing or carrying a caller-selected model', () => {
    const [draft, setDraft] = createSignal('Answer briefly');
    const [mode, setMode] = createSignal<ChatComposerMode>('agent');
    let submitted: ChatComposerSubmitInput | null = null;

    render(() => (
      <ChatComposer
        ariaLabel="Chat starter"
        canSubmit={true}
        inputLabel="Thread title"
        isSubmitting={false}
        mode={mode()}
        models={models}
        onInput={setDraft}
        onModeChange={setMode}
        onModelChange={() => undefined}
        onSubmit={(input) => {
          submitted = input;
        }}
        placeholder="Ask OpenKit anything."
        quickChatEnabled={true}
        selectedModelId="model_codex"
        selectedWorkspaceId="ws_demo"
        submitLabel="Start thread"
        value={draft()}
        workspaceLocked={false}
        workspaces={workspaces}
      />
    ));

    fireEvent.click(screen.getByRole('button', { name: /quick chat/i }));

    expect(mode()).toBe('quick');
    expect(screen.queryByRole('combobox', { name: /model/i })).toBeNull();
    expect(screen.getByRole('button', { name: /use voice input/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /start thread/i }));
    expect(submitted).toEqual({
      input: 'Answer briefly',
      mode: 'quick',
      workspaceId: 'ws_demo',
    });
  });
});
