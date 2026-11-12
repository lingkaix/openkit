import { ApiCallError } from '@openkit/core-client';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Composer, type ComposerDraft } from '../../../primitives/Composer';
import { lintCopyText, timelineCopy } from './copy';
import { SteerOutcome } from './SteerOutcome';
import {
  composerLiveMode,
  readSteerQualification,
  type SteerReceiptView,
  steerCopy,
  steerReasonSentence,
} from './steer';

const TURN = 'tu_fixture';
const REQUEST = 'req_fixture';
const NOTE = 'Bring the note into this run.';

function receipt(state: SteerReceiptView['state'], text: string | null = NOTE): SteerReceiptView {
  return { requestId: REQUEST, turnId: TURN, text, state, reason: null };
}

describe('steer outcomes', () => {
  it('renders all four outcomes from the receipt', () => {
    const { rerender } = render(<SteerOutcome receipt={receipt('sending')} />);
    expect(screen.getByRole('status').textContent).toBe(steerCopy.sending);
    rerender(<SteerOutcome receipt={receipt('accepted')} />);
    expect(screen.getByRole('status').textContent).toBe(steerCopy.accepted);
    rerender(<SteerOutcome receipt={receipt('not-delivered')} />);
    expect(screen.getByRole('status').textContent).toBe(steerCopy.notDelivered);
    expect(screen.getByText(steerCopy.notDeliveredDetail)).toBeTruthy();
    rerender(<SteerOutcome receipt={receipt('unknown')} />);
    expect(screen.getByRole('status').textContent).toBe(steerCopy.unknown);
    expect(screen.getByText(steerCopy.unknownDetail)).toBeTruthy();
  });

  it('keeps the same outcome after the view is remounted', () => {
    const view = <SteerOutcome receipt={receipt('accepted')} />;
    const first = render(view);
    expect(screen.getByRole('status').textContent).toBe(steerCopy.accepted);
    first.unmount();
    render(view);
    expect(screen.getByRole('status').textContent).toBe(steerCopy.accepted);
  });

  it('reuses the exact target, text, and request id for Check and Retry', async () => {
    const user = userEvent.setup();
    const onReplay = vi.fn();
    const { rerender } = render(
      <SteerOutcome onReplay={onReplay} receipt={receipt('not-delivered')} />
    );
    await user.click(screen.getByRole('button', { name: steerCopy.retry }));
    expect(onReplay).toHaveBeenCalledWith({ turnId: TURN, requestId: REQUEST, text: NOTE });
    rerender(<SteerOutcome onReplay={onReplay} receipt={receipt('unknown')} />);
    await user.click(screen.getByRole('button', { name: steerCopy.check }));
    expect(onReplay).toHaveBeenLastCalledWith({ turnId: TURN, requestId: REQUEST, text: NOTE });
    expect(onReplay.mock.calls[1]?.[0].requestId).toBe(REQUEST);
  });

  it('hides Check and Retry when the read has no exact text', () => {
    render(<SteerOutcome onReplay={vi.fn()} receipt={receipt('unknown', null)} />);
    expect(screen.getByRole('status').textContent).toBe(steerCopy.unknown);
    expect(screen.queryByRole('button', { name: steerCopy.check })).toBeNull();
    expect(screen.queryByRole('button', { name: steerCopy.retry })).toBeNull();
  });
});

describe('steer qualification', () => {
  it('offers Steer only when the read says the worker can take a note', () => {
    expect(composerLiveMode({ task: false, runningTurnId: TURN, qualified: true })).toBeNull();
    expect(composerLiveMode({ task: true, runningTurnId: null, qualified: true })).toBeNull();
    expect(composerLiveMode({ task: true, runningTurnId: TURN, qualified: true })).toMatchObject({
      mode: 'steer',
      consequence: steerCopy.consequence,
    });
    expect(composerLiveMode({ task: true, runningTurnId: TURN, qualified: false })).toMatchObject({
      mode: 'keep-draft',
      consequence: steerCopy.unqualified,
    });
    expect(composerLiveMode({ task: true, runningTurnId: TURN, qualified: null })).toMatchObject({
      mode: 'keep-draft',
      consequence: steerCopy.unqualified,
    });
  });

  it('does not invent qualification when the catalog omits it', () => {
    expect(readSteerQualification(undefined)).toBeNull();
    expect(readSteerQualification([{ kind: 'running-worker' }])).toBeNull();
    expect(readSteerQualification([{ kind: 'running-worker', steerAvailability: true }])).toBe(
      true
    );
    expect(readSteerQualification([{ kind: 'running-worker', steerAvailability: false }])).toBe(
      false
    );
  });

  it('keeps raw error codes off the outcome line', () => {
    expect(steerReasonSentence('steer_busy')).toBe(steerCopy.busy);
    expect(steerReasonSentence('steer_unsupported')).toBe(steerCopy.unqualified);
    expect(steerReasonSentence('steer_target_stale')).toBe(steerCopy.ended);
    expect(steerReasonSentence('tu_secret')).toBeNull();
  });

  it('passes the same copy lint as the rest of the timeline', () => {
    expect(Object.values(steerCopy).flatMap((text) => lintCopyText(text))).toEqual([]);
  });
});

describe('composer steer', () => {
  it('keeps the draft when the worker cannot take a note, and does not send it later', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const liveInput = {
      mode: 'keep-draft' as const,
      turnId: TURN,
      consequence: steerCopy.unqualified,
      actionLabel: steerCopy.keepDraft,
    };
    const onStop = vi.fn();
    const { rerender } = render(
      <Composer
        liveInput={liveInput}
        onSubmit={onSubmit}
        phoneRun={{
          stop: {
            label: timelineCopy.stopRun,
            pending: false,
            consequence: timelineCopy.stopConsequence,
            waitReason: timelineCopy.waitForStop,
            onStop,
          },
        }}
      />
    );
    expect(screen.getByText(steerCopy.unqualified)).toBeTruthy();
    const input = screen.getByRole('textbox', { name: 'Message' });
    await user.type(input, NOTE);
    await user.click(screen.getByRole('button', { name: steerCopy.keepDraft }));
    await user.click(screen.getByRole('button', { name: timelineCopy.stopRun }));
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(input).toHaveValue(NOTE);
    rerender(<Composer onSubmit={onSubmit} />);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(input).toHaveValue(NOTE);
  });

  it('keeps the draft and the request id when delivery is refused', async () => {
    const user = userEvent.setup();
    const onSubmit = vi
      .fn()
      .mockRejectedValue(new ApiCallError(409, 'busy', { code: 'steer_busy' }));
    render(
      <Composer
        initialDraft={{ input: NOTE, targetRef: '', requestId: REQUEST }}
        liveInput={{
          mode: 'steer',
          turnId: TURN,
          consequence: steerCopy.consequence,
          actionLabel: steerCopy.steer,
        }}
        onSubmit={onSubmit}
      />
    );
    const steer = screen.getByRole('button', { name: steerCopy.steer });
    await user.click(steer);
    await user.click(steer);
    expect(onSubmit).toHaveBeenCalledTimes(2);
    const first = onSubmit.mock.calls[0]?.[0] as ComposerDraft;
    const second = onSubmit.mock.calls[1]?.[0] as ComposerDraft;
    expect(first.requestId).toBe(REQUEST);
    expect(second.requestId).toBe(REQUEST);
    expect(first.input).toBe(NOTE);
    expect(second.input).toBe(NOTE);
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(NOTE);
  });

  it('does not send a blank note', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <Composer
        liveInput={{
          mode: 'steer',
          turnId: TURN,
          consequence: steerCopy.consequence,
          actionLabel: steerCopy.steer,
        }}
        onSubmit={onSubmit}
      />
    );
    const input = screen.getByRole('textbox', { name: 'Message' });
    await user.type(input, '   ');
    expect(screen.getByRole('button', { name: steerCopy.steer })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('blocks a note that includes more than text until those choices are removed', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <Composer
        initialDraft={{
          input: NOTE,
          targetRef: '',
          requestId: REQUEST,
          reasoningEffort: 'high',
        }}
        liveInput={{
          mode: 'steer',
          turnId: TURN,
          consequence: steerCopy.consequence,
          actionLabel: steerCopy.steer,
        }}
        onSubmit={onSubmit}
      />
    );
    expect(screen.getByText(steerCopy.inapplicable)).toBeTruthy();
    expect(screen.getByRole('button', { name: steerCopy.steer })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: steerCopy.clearExtras }));
    await user.click(screen.getByRole('button', { name: steerCopy.steer }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const draft = onSubmit.mock.calls[0]?.[0] as ComposerDraft;
    expect(draft.input).toBe(NOTE);
    expect(draft.reasoningEffort).toBeUndefined();
    expect(draft.files).toBeUndefined();
  });
});
