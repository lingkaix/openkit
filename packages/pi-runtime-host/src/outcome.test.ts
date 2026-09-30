import { describe, expect, it } from 'vitest';
import { PI_RESULT_CONTENT_MAX_BYTES, PiTurnOutcomeTracker } from './outcome.ts';

const route = { model: 'logical-a', provider: 'openkit-worker-inference' };

function assistant(overrides: Record<string, unknown> = {}) {
  return {
    content: [{ text: 'done', type: 'text' }],
    model: route.model,
    provider: route.provider,
    role: 'assistant',
    stopReason: 'stop',
    ...overrides,
  };
}

/** Feeds the event sequence of one settled successful prompt. */
function settle(tracker: PiTurnOutcomeTracker, message: Record<string, unknown>): void {
  tracker.observe({ message, type: 'message_end' });
  tracker.observe({ message, type: 'turn_end' });
  tracker.observe({ messages: [{ role: 'user' }, message], type: 'agent_end', willRetry: false });
  tracker.observe({ type: 'agent_settled' });
}

function finish(
  tracker: PiTurnOutcomeTracker,
  overrides: Partial<{ interrupted: boolean; promptFailed: boolean }> = {}
) {
  return tracker.finish({ interrupted: false, promptFailed: false, route, ...overrides });
}

describe('PiTurnOutcomeTracker', () => {
  it('completes with text parts concatenated in order and trimmed once', () => {
    const tracker = new PiTurnOutcomeTracker();
    settle(
      tracker,
      assistant({
        content: [
          { text: '  first', type: 'text' },
          { thinking: 'hidden', type: 'thinking' },
          { text: ' second  ', type: 'text' },
        ],
      })
    );
    expect(finish(tracker)).toEqual({ assistantText: 'first second', status: 'completed' });
  });

  it('ignores unknown events, which cannot satisfy settlement', () => {
    const tracker = new PiTurnOutcomeTracker();
    tracker.observe({ type: 'future_event' });
    settle(tracker, assistant());
    tracker.observe({ payload: 1, type: 'another_future_event' });
    expect(finish(tracker)).toEqual({ assistantText: 'done', status: 'completed' });

    const unsettled = new PiTurnOutcomeTracker();
    unsettled.observe({ message: assistant(), type: 'message_end' });
    unsettled.observe({ type: 'agent_settled_v2' });
    expect(finish(unsettled)).toEqual({
      reason: 'pi-terminal-correlation-failed',
      status: 'failed',
    });
  });

  it.each([
    ['error', assistant({ stopReason: 'error' })],
    ['abort', assistant({ stopReason: 'aborted' })],
    ['length exhaustion', assistant({ stopReason: 'length' })],
    ['terminal tool use', assistant({ stopReason: 'toolUse' })],
  ])('rejects %s', (_name, message) => {
    const tracker = new PiTurnOutcomeTracker();
    settle(tracker, message);
    expect(finish(tracker)).toEqual({ reason: 'pi-terminal-correlation-failed', status: 'failed' });
  });

  it('rejects an unresolved retry', () => {
    const tracker = new PiTurnOutcomeTracker();
    const message = assistant();
    tracker.observe({ message, type: 'message_end' });
    tracker.observe({ message, type: 'turn_end' });
    tracker.observe({ messages: [message], type: 'agent_end', willRetry: true });
    tracker.observe({ type: 'agent_settled' });
    expect(finish(tracker)).toEqual({ reason: 'pi-terminal-correlation-failed', status: 'failed' });
  });

  it('accepts a retry that later completes', () => {
    const tracker = new PiTurnOutcomeTracker();
    const failed = assistant({ stopReason: 'error' });
    tracker.observe({ message: failed, type: 'message_end' });
    tracker.observe({ message: failed, type: 'turn_end' });
    tracker.observe({ messages: [failed], type: 'agent_end', willRetry: true });
    settle(tracker, assistant({ content: [{ text: 'retried', type: 'text' }] }));
    expect(finish(tracker)).toEqual({ assistantText: 'retried', status: 'completed' });
  });

  it('rejects contradictory terminal evidence', () => {
    const mismatch = new PiTurnOutcomeTracker();
    const message = assistant();
    mismatch.observe({ message, type: 'message_end' });
    mismatch.observe({ message: assistant({ content: [] }), type: 'turn_end' });
    mismatch.observe({ messages: [message], type: 'agent_end', willRetry: false });
    mismatch.observe({ type: 'agent_settled' });
    expect(finish(mismatch).status).toBe('failed');

    const afterSettlement = new PiTurnOutcomeTracker();
    settle(afterSettlement, assistant());
    afterSettlement.observe({ message: assistant(), type: 'message_end' });
    expect(finish(afterSettlement)).toEqual({
      reason: 'pi-terminal-correlation-failed',
      status: 'failed',
    });
  });

  it('requires the admitted model', () => {
    const tracker = new PiTurnOutcomeTracker();
    settle(tracker, assistant({ model: 'logical-b' }));
    expect(finish(tracker)).toEqual({ reason: 'pi-route-mismatch', status: 'failed' });
  });

  it('requires the admitted provider alias', () => {
    const tracker = new PiTurnOutcomeTracker();
    settle(tracker, assistant({ provider: 'another-provider' }));
    expect(finish(tracker)).toEqual({ reason: 'pi-route-mismatch', status: 'failed' });
  });

  it('rejects an empty combined result and content over 16 MiB', () => {
    const empty = new PiTurnOutcomeTracker();
    settle(empty, assistant({ content: [{ text: '  ', type: 'text' }] }));
    expect(finish(empty)).toEqual({ reason: 'pi-final-message-empty', status: 'failed' });

    // Bytes the serialized content array adds around the text of its one part.
    const envelope = Buffer.byteLength(JSON.stringify([{ text: '', type: 'text' }]), 'utf8');
    const large = new PiTurnOutcomeTracker();
    settle(
      large,
      assistant({
        content: [{ text: 'a'.repeat(PI_RESULT_CONTENT_MAX_BYTES - envelope + 1), type: 'text' }],
      })
    );
    expect(finish(large)).toEqual({ reason: 'pi-output-too-large', status: 'failed' });

    const bound = new PiTurnOutcomeTracker();
    settle(
      bound,
      assistant({
        content: [{ text: 'a'.repeat(PI_RESULT_CONTENT_MAX_BYTES - envelope), type: 'text' }],
      })
    );
    expect(finish(bound).status).toBe('completed');
  });

  it('bounds non-text parts with the final text', () => {
    const tracker = new PiTurnOutcomeTracker();
    settle(
      tracker,
      assistant({
        content: [
          { thinking: 'a'.repeat(PI_RESULT_CONTENT_MAX_BYTES), type: 'thinking' },
          { text: 'done', type: 'text' },
        ],
      })
    );
    expect(finish(tracker)).toEqual({ reason: 'pi-output-too-large', status: 'failed' });
  });

  it('rejects malformed content parts instead of skipping them', () => {
    for (const part of [
      { text: 42, type: 'text' },
      { type: 'text' },
      { text: 'done' },
      'done',
      null,
      ['done'],
    ]) {
      const tracker = new PiTurnOutcomeTracker();
      settle(tracker, assistant({ content: [part, { text: 'done', type: 'text' }] }));
      expect(finish(tracker)).toEqual({ reason: 'pi-output-malformed', status: 'failed' });
    }
    const thinking = new PiTurnOutcomeTracker();
    settle(
      thinking,
      assistant({
        content: [
          { thinking: 'plan', type: 'thinking' },
          { text: 'done', type: 'text' },
        ],
      })
    );
    expect(finish(thinking)).toEqual({ assistantText: 'done', status: 'completed' });
  });

  it('lets interruption win over a completed message and reports prompt rejection', () => {
    const tracker = new PiTurnOutcomeTracker();
    settle(tracker, assistant());
    expect(finish(tracker, { interrupted: true })).toEqual({
      reason: 'worker-interrupted',
      status: 'interrupted',
    });
    expect(finish(new PiTurnOutcomeTracker(), { promptFailed: true })).toEqual({
      reason: 'pi-prompt-failed',
      status: 'failed',
    });
  });
});
