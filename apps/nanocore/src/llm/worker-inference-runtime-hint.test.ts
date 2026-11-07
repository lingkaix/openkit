import { describe, expect, it } from 'vitest';
import { readWorkerInferenceRuntimeHint } from './worker-inference-runtime-hint.js';

const hint = {
  nativeSessionId: 'native-session',
  nativeThreadId: 'native-thread',
  runtimeFamily: 'codex',
};

describe('normalized worker inference runtime hints', () => {
  it('validates the existing hint contract and ignores additive fields', () => {
    expect(readWorkerInferenceRuntimeHint({ ...hint, extension: 'ignored' }, 'codex')).toEqual(
      hint
    );
  });

  it('leaves an absent normalized hint absent', () => {
    expect(readWorkerInferenceRuntimeHint(undefined, 'codex')).toBeUndefined();
  });

  it.each([
    null,
    [],
    {},
    { ...hint, nativeThreadId: '' },
    { ...hint, nativeTurnId: null },
    { ...hint, nativeSessionId: 'x'.repeat(16 * 1024 + 1) },
    { ...hint, runtimeFamily: 'unknown' },
    { ...hint, subagentKind: 'private-label' },
  ])('rejects malformed normalized hints with a fixed message: %#', (value) => {
    expect(() => readWorkerInferenceRuntimeHint(value, 'codex')).toThrow(
      'Worker inference runtime hint is invalid.'
    );
  });

  it('rejects a normalized hint from another bound runtime', () => {
    expect(() => readWorkerInferenceRuntimeHint(hint, 'pi')).toThrow(
      'Worker inference runtime hint is invalid.'
    );
  });

  it('rejects raw legacy envelopes that lack normalized fields', () => {
    expect(() =>
      readWorkerInferenceRuntimeHint({ 'x-codex-turn-metadata': { turn_id: 'native' } }, 'codex')
    ).toThrow('Worker inference runtime hint is invalid.');
    expect(() =>
      readWorkerInferenceRuntimeHint({ client_metadata: { thread_id: 'native' } }, 'codex')
    ).toThrow('Worker inference runtime hint is invalid.');
  });

  it('strips legacy properties when normalized fields are present', () => {
    expect(
      readWorkerInferenceRuntimeHint(
        {
          ...hint,
          request_kind: 'turn',
          collab_spawn: true,
          'x-codex-turn-metadata': { turn_id: 'native' },
          client_metadata: { session_id: 'native' },
        },
        'codex'
      )
    ).toEqual(hint);
  });
});
