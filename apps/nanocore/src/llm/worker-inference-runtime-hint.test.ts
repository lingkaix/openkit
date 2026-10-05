import { readFileSync } from 'node:fs';
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

  it('removes native parsing from Core', () => {
    const source = readFileSync(
      new URL('./worker-inference-runtime-hint.ts', import.meta.url),
      'utf8'
    );
    for (const nativeField of [
      'x-codex-turn-metadata',
      'client_metadata',
      'request_kind',
      'collab_spawn',
    ]) {
      expect(source).not.toContain(nativeField);
    }
  });
});
