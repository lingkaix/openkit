import type { ConversationTargetCatalog } from '@openkit/app-api-schemas';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer } from './Composer';
import { VOICE_INPUT_LIMIT_MS } from './voice-input';

const catalog: ConversationTargetCatalog = {
  workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  threadId: null,
  defaultTargetRef: 'internal-role:assistant',
  targets: [
    {
      targetRef: 'internal-role:assistant',
      kind: 'assistant',
      label: 'Assistant',
      description: null,
      availability: 'available',
      unavailableReason: null,
      threadId: null,
      profileId: null,
      logicalModels: [{ id: 'reasoning', label: 'Reasoning', capabilities: ['chat'] }],
      defaultLogicalModelId: 'reasoning',
    },
  ],
};

class FakeRecorder {
  static instances: FakeRecorder[] = [];
  state: 'inactive' | 'recording' = 'inactive';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  mimeType: string;
  constructor(_stream: MediaStream, options?: { mimeType?: string }) {
    this.mimeType = options?.mimeType ?? 'audio/webm';
    FakeRecorder.instances.push(this);
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['clip'], { type: this.mimeType }) });
    this.onstop?.();
  }
  static isTypeSupported(value: string) {
    return value === 'audio/webm;codecs=opus';
  }
}

function installCapture(getUserMedia: ReturnType<typeof vi.fn>) {
  FakeRecorder.instances = [];
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  });
  vi.stubGlobal('MediaRecorder', FakeRecorder);
}

function stream() {
  return {
    getTracks: () => [{ addEventListener: () => undefined, stop: () => undefined }],
  } as unknown as MediaStream;
}

describe.each([1024, 360])('composer voice input at width %i', (width) => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('hides the mic when no transcription route is usable', () => {
    installCapture(vi.fn());
    const { rerender } = render(
      <Composer variant="assistant" targetCatalog={catalog} onSubmit={vi.fn()} />
    );
    expect(screen.queryByRole('button', { name: 'Voice input' })).toBeNull();
    rerender(
      <Composer
        variant="assistant"
        targetCatalog={catalog}
        voice={{ unavailableReason: 'Voice input is unavailable: missing base URL.' }}
        onSubmit={vi.fn()}
      />
    );
    expect(screen.queryByRole('button', { name: 'Voice input' })).toBeNull();
    expect(screen.getByText('Voice input is unavailable: missing base URL.')).toBeTruthy();
  });

  it('keeps the draft and calls nothing on permission denial, cancel, and empty text', async () => {
    const denied = vi.fn().mockRejectedValue(new Error('denied'));
    installCapture(denied);
    const transcribe = vi.fn();
    const onSubmit = vi.fn();
    const { rerender } = render(
      <Composer
        variant="assistant"
        targetCatalog={catalog}
        initialDraft={{ input: 'Keep this', targetRef: 'internal-role:assistant' }}
        voice={{ transcribe }}
        onSubmit={onSubmit}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Voice input' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Voice input is unavailable.');
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Keep this');
    expect(transcribe).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss voice input' }));
    expect(screen.getByRole('button', { name: 'Voice input' })).toBeTruthy();

    const allowed = vi.fn().mockResolvedValue(stream());
    installCapture(allowed);
    rerender(
      <Composer
        variant="assistant"
        targetCatalog={catalog}
        initialDraft={{ input: 'Keep this', targetRef: 'internal-role:assistant' }}
        voice={{ transcribe }}
        onSubmit={onSubmit}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Voice input' }));
    expect(await screen.findByRole('button', { name: 'Cancel voice input' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel voice input' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Voice input' })).toBeTruthy());
    expect(transcribe).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Keep this');

    transcribe.mockResolvedValue({ text: '   ' });
    fireEvent.click(screen.getByRole('button', { name: 'Voice input' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Stop voice input' }));
    await waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Keep this');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('appends text, disables Send while active, and drops a late abort response', async () => {
    installCapture(vi.fn().mockResolvedValue(stream()));
    let resolveLate: ((value: { text: string }) => void) | undefined;
    const transcribe = vi
      .fn()
      .mockResolvedValueOnce({ text: 'there' })
      .mockImplementationOnce(
        () =>
          new Promise<{ text: string }>((resolve) => {
            resolveLate = resolve;
          })
      );
    const onSubmit = vi.fn();
    render(
      <Composer
        variant="assistant"
        targetCatalog={catalog}
        initialDraft={{ input: 'Hello', targetRef: 'internal-role:assistant' }}
        voice={{ transcribe }}
        onSubmit={onSubmit}
      />
    );
    const field = screen.getByRole('textbox', { name: 'Message' });
    field.focus();
    const mic = screen.getByRole('button', { name: 'Voice input' });
    fireEvent.mouseDown(mic);
    expect(field).toHaveFocus();
    fireEvent.click(mic);
    const send = screen.getByRole('button', { name: 'Send message' });
    expect(await screen.findByRole('button', { name: 'Stop voice input' })).toBeTruthy();
    expect(send).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop voice input' }));
    await waitFor(() => expect(field).toHaveValue('Hello there'));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(send).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Voice input' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Stop voice input' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Abort voice input' }));
    resolveLate?.({ text: 'late words' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Voice input' })).toBeTruthy());
    expect(field).toHaveValue('Hello there');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('stops at the client cap and retries the clip still in memory', async () => {
    const capTimers: Array<() => void> = [];
    const originalSetTimeout = window.setTimeout.bind(window);
    vi.spyOn(window, 'setTimeout').mockImplementation(((
      handler: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay === VOICE_INPUT_LIMIT_MS) {
        capTimers.push(() => {
          if (typeof handler === 'function') handler(...args);
        });
        return 0;
      }
      return originalSetTimeout(handler, delay, ...args);
    }) as typeof window.setTimeout);
    installCapture(vi.fn().mockResolvedValue(stream()));
    const transcribe = vi
      .fn()
      .mockRejectedValueOnce(new Error('upstream'))
      .mockResolvedValueOnce({ text: 'recovered' });
    render(
      <Composer
        variant="assistant"
        targetCatalog={catalog}
        initialDraft={{ input: 'Hello', targetRef: 'internal-role:assistant' }}
        voice={{ transcribe }}
        onSubmit={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Voice input' }));
    await waitFor(() => expect(capTimers).toHaveLength(1));
    capTimers[0]!();
    expect(await screen.findByRole('alert')).toHaveTextContent('Transcription failed.');
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Hello');
    fireEvent.click(screen.getByRole('button', { name: 'Retry voice input' }));
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Hello recovered')
    );
    expect(transcribe).toHaveBeenCalledTimes(2);
  });
});
