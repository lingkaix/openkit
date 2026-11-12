import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Composer, type ComposerDraft } from '../../../primitives/Composer';
import { timelineCopy } from './copy';
import { SteerOutcome } from './SteerOutcome';
import { type SteerReceiptView, steerCopy } from './steer';

const TURN_ID = 'tu_fixture';

/**
 * Dev-only steer surface. The isolated browser check opens this route.
 * Accepted here is a retained receipt in the URL, because the simulator cannot accept a steer.
 */
export function SteerFixtureScreen() {
  const [params, setParams] = useSearchParams();
  const scene = params.get('scene') ?? 'offer';
  const text = params.get('text') ?? 'Bring the note into this run.';
  const requestId = params.get('requestId') ?? 'req_fixture';
  const [stopped, setStopped] = useState(false);
  const receipt = receiptFor(scene, requestId, text);

  function accept(draft: ComposerDraft) {
    const next = new URLSearchParams();
    next.set('scene', 'accepted');
    next.set('text', draft.input);
    next.set('requestId', draft.requestId);
    setParams(next, { replace: true });
  }

  function replaySame(kind: 'not-delivered' | 'unknown') {
    const next = new URLSearchParams();
    next.set('scene', kind);
    next.set('text', text);
    next.set('requestId', requestId);
    setParams(next, { replace: true });
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
      <h1 className="text-xl font-semibold">Steer fixture</h1>
      {receipt ? (
        <SteerOutcome
          receipt={receipt}
          onReplay={() => replaySame(receipt.state === 'unknown' ? 'unknown' : 'not-delivered')}
        />
      ) : null}
      {scene === 'unqualified' ? (
        <Composer
          key="unqualified"
          liveInput={{
            mode: 'keep-draft',
            turnId: TURN_ID,
            consequence: steerCopy.unqualified,
            actionLabel: steerCopy.keepDraft,
          }}
          phoneRun={
            stopped
              ? undefined
              : {
                  stop: {
                    label: timelineCopy.stopRun,
                    pending: false,
                    consequence: timelineCopy.stopConsequence,
                    waitReason: timelineCopy.waitForStop,
                    onStop: () => setStopped(true),
                  },
                }
          }
          onSubmit={() => Promise.resolve()}
        />
      ) : (
        <Composer
          key={`${scene}:${requestId}`}
          initialDraft={
            scene === 'not-delivered' || scene === 'unknown'
              ? { input: text, targetRef: '', requestId }
              : undefined
          }
          liveInput={{
            mode: 'steer',
            turnId: TURN_ID,
            consequence: steerCopy.consequence,
            actionLabel: steerCopy.steer,
          }}
          onSubmit={
            scene === 'offer'
              ? accept
              : () => replaySame(scene === 'unknown' ? 'unknown' : 'not-delivered')
          }
        />
      )}
    </main>
  );
}

function receiptFor(scene: string, requestId: string, text: string): SteerReceiptView | null {
  if (scene === 'accepted') {
    return { requestId, turnId: TURN_ID, text, state: 'accepted', reason: null };
  }
  if (scene === 'not-delivered') {
    return { requestId, turnId: TURN_ID, text, state: 'not-delivered', reason: 'steer_busy' };
  }
  if (scene === 'unknown') {
    return { requestId, turnId: TURN_ID, text, state: 'unknown', reason: null };
  }
  return null;
}
