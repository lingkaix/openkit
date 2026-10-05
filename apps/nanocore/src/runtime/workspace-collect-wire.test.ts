import { describe, expect, it } from 'vitest';
import {
  admitWorkspaceCollectJsonResult,
  sameWorkspaceSnapshot,
  WorkspaceCollectCommandSchema,
  WorkspaceCollectionError,
  WorkspaceCollectionRecoveryCauseSchema,
  WorkspaceCollectJsonResultSchema,
} from './workspace-collect-wire.js';

const pair = { tree: '1'.repeat(40), manifest: '2'.repeat(40) };
const other = { tree: '3'.repeat(40), manifest: '4'.repeat(40) };
const command = {
  requestId: 'a'.repeat(64),
  storageRef: 'store',
  scopeDigest: `sha256:${'b'.repeat(64)}`,
  attachmentGeneration: 1,
  sandboxId: 'sandbox',
  workSlot: 'slot',
  collectionId: 'collect',
  mode: 'capture' as const,
  acceptedBase: pair,
  previousHead: other,
  checkValues: { runtimeEnv: [], loopbackDigests: ['c'.repeat(64), 'd'.repeat(64)] },
};
describe('workspace collection closed wire', () => {
  it('retains closed failure distinctions and refuses an unknown recovery cause', () => {
    for (const cause of WorkspaceCollectionRecoveryCauseSchema.options) {
      const error = new WorkspaceCollectionError({ outcome: 'recovery_required', cause });
      expect(error.outcome).toBe('recovery_required');
      expect(error.cause).toBe(cause);
    }
    for (const outcome of ['credential_hit', 'effect_failed'] as const) {
      expect(new WorkspaceCollectionError({ outcome }).outcome).toBe(outcome);
      expect(new WorkspaceCollectionError({ outcome }).cause).toBeUndefined();
    }
    expect(
      () => new WorkspaceCollectionError({ outcome: 'recovery_required', cause: 'future' })
    ).toThrow();
  });
  it('admits the exact command core and ignores additive members', () => {
    expect(WorkspaceCollectCommandSchema.parse({ ...command, additive: { future: true } })).toEqual(
      command
    );
    expect(
      WorkspaceCollectCommandSchema.parse({
        ...command,
        mode: 'baseline',
        acceptedBase: null,
        previousHead: null,
      }).mode
    ).toBe('baseline');
    expect(() => WorkspaceCollectCommandSchema.parse({ ...command, mode: 'baseline' })).toThrow();
  });
  // Short labels keep generated credential payloads out of CI test names.
  it.each([
    ['empty storage reference', { storageRef: '' }],
    ['leading storage reference whitespace', { storageRef: ' store' }],
    ['storage reference control character', { storageRef: 'store\n' }],
    ['oversized storage reference', { storageRef: 'é'.repeat(257) }],
    ['invalid scope digest', { scopeDigest: 'sha256:ABCD' }],
    ['empty sandbox id', { sandboxId: '' }],
    ['sandbox id control character', { sandboxId: 'a\0' }],
    ['oversized sandbox id', { sandboxId: 'é'.repeat(257) }],
    ['zero attachment generation', { attachmentGeneration: 0 }],
    ['fractional attachment generation', { attachmentGeneration: 1.5 }],
    ['unsafe attachment generation', { attachmentGeneration: Number.MAX_SAFE_INTEGER + 1 }],
    ['work slot path separator', { workSlot: 'a/b' }],
    ['oversized work slot', { workSlot: 'a'.repeat(129) }],
    ['collection id traversal', { collectionId: '../slot' }],
    ['uppercase request id', { requestId: 'A'.repeat(64) }],
    [
      'non-SHA-1 accepted tree',
      { acceptedBase: { tree: 'a'.repeat(64), manifest: pair.manifest } },
    ],
    ['missing previous head', { previousHead: null }],
    ['nonhex previous manifest', { previousHead: { tree: other.tree, manifest: 'g'.repeat(40) } }],
    [
      'empty runtime credential',
      { checkValues: { runtimeEnv: [''], loopbackDigests: command.checkValues.loopbackDigests } },
    ],
    [
      'runtime credential NUL',
      {
        checkValues: { runtimeEnv: ['a\0b'], loopbackDigests: command.checkValues.loopbackDigests },
      },
    ],
    [
      'oversized runtime credential',
      {
        checkValues: {
          runtimeEnv: ['é'.repeat(32769)],
          loopbackDigests: command.checkValues.loopbackDigests,
        },
      },
    ],
    [
      'too many runtime credentials',
      {
        checkValues: {
          runtimeEnv: Array(129).fill('value'),
          loopbackDigests: command.checkValues.loopbackDigests,
        },
      },
    ],
    [
      'nonhex loopback digest',
      { checkValues: { runtimeEnv: [], loopbackDigests: ['x'.repeat(64), 'd'.repeat(64)] } },
    ],
    [
      'missing loopback digest',
      { checkValues: { runtimeEnv: [], loopbackDigests: ['c'.repeat(64)] } },
    ],
  ])('refuses inadmissible command content: %s', (_label, patch) => {
    expect(() => WorkspaceCollectCommandSchema.parse({ ...command, ...patch })).toThrow();
  });
  it('admits exact association and credential byte boundaries', () => {
    expect(
      WorkspaceCollectCommandSchema.parse({
        ...command,
        storageRef: 'é'.repeat(256),
        sandboxId: 'é'.repeat(256),
        attachmentGeneration: Number.MAX_SAFE_INTEGER,
        checkValues: {
          runtimeEnv: Array(128).fill('é'.repeat(32768)),
          loopbackDigests: command.checkValues.loopbackDigests,
        },
      })
    ).toBeDefined();
  });
  it.each(
    WorkspaceCollectionRecoveryCauseSchema.options
  )('preserves the closed recovery cause %s', (cause) => {
    expect(
      admitWorkspaceCollectJsonResult(
        { requestId: command.requestId, outcome: 'recovery_required', cause, additive: true },
        WorkspaceCollectCommandSchema.parse(command)
      )
    ).toEqual({ requestId: command.requestId, outcome: 'recovery_required', cause });
  });
  it('rejects unknown outcomes, causes and mismatched request or mode', () => {
    for (const result of [
      { requestId: command.requestId, outcome: 'baseline_unstable' },
      { requestId: command.requestId, outcome: 'recovery_required', cause: 'future' },
      { requestId: 'e'.repeat(64), outcome: 'effect_failed' },
      { requestId: command.requestId, outcome: 'baseline', head: pair },
    ])
      expect(() =>
        admitWorkspaceCollectJsonResult(result, WorkspaceCollectCommandSchema.parse(command))
      ).toThrow();
    for (const outcome of ['empty', 'no_new_head'])
      expect(() =>
        admitWorkspaceCollectJsonResult(
          {
            requestId: command.requestId,
            outcome,
            unstable: false,
            head: pair,
            previousHead: other,
            acceptedBase: pair,
          },
          WorkspaceCollectCommandSchema.parse({
            ...command,
            mode: 'baseline',
            acceptedBase: null,
            previousHead: null,
          })
        )
      ).toThrow('capture result disagrees');
    expect(() =>
      WorkspaceCollectJsonResultSchema.parse({
        requestId: command.requestId,
        outcome: 'no_new_head',
      })
    ).toThrow();
  });
  it('requires both snapshot components and a contiguous empty return to the accepted base', () => {
    expect(sameWorkspaceSnapshot(pair, { ...pair, manifest: other.manifest })).toBe(false);
    const empty = {
      requestId: command.requestId,
      outcome: 'empty',
      previousHead: other,
      acceptedBase: pair,
      head: pair,
      unstable: false,
    };
    expect(
      admitWorkspaceCollectJsonResult(empty, WorkspaceCollectCommandSchema.parse(command))
    ).toEqual(empty);
    for (const patch of [
      { previousHead: pair },
      { acceptedBase: other },
      { head: other },
      { head: { ...pair, manifest: other.manifest } },
    ])
      expect(() =>
        admitWorkspaceCollectJsonResult(
          { ...empty, ...patch },
          WorkspaceCollectCommandSchema.parse(command)
        )
      ).toThrow();
  });
});
