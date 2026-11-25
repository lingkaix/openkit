import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ControlHarnessLifecycleInputSchema } from './harness-lifecycle-codecs.js';

/**
 * CLOSE-LC S3b (G3): the private restore and claim frames across a mixed local pair. Main and its
 * control-store Worker come from the same NanoCore distribution; a mismatched pair must fail
 * closed on the new arm and the new field, and keep the old close frame.
 */

/** The codec's identity at `6d0b00087` (`harness-lifecycle-codecs.ts:4`). */
const identity = z.string().min(1);

/**
 * The strict restore frame of the binary before G3 (`6d0b00087`,
 * `harness-lifecycle-codecs.ts:140–156`), copied so that an older peer is a fixed codec here.
 */
const preG3Restore = z
  .object({
    kind: z.literal('sandbox.restore-admission'),
    sandboxRuntimeId: identity,
    harness: z
      .object({
        harnessInstanceId: identity,
        harnessBindingRef: identity,
        close: z
          .object({ operationId: identity, sequence: z.number().int().nonnegative().safe() })
          .strict(),
      })
      .strict()
      .optional(),
  })
  .strict();

const harness = { harnessInstanceId: 'harness-g3', harnessBindingRef: 'harness-binding-g3' };
const close = { operationId: 'op-g3', sequence: 4 };
const claim = { revision: '2098-08-21T00:00:01.000Z' };
const restore = (scoped: Record<string, unknown>) => ({
  kind: 'sandbox.restore-admission',
  sandboxRuntimeId: 'sandbox-g3',
  harness: { ...harness, ...scoped },
});
const parses = (input: unknown) => ControlHarnessLifecycleInputSchema.safeParse(input).success;

describe('the G3 restore frame across a mixed local pair (CLOSE-LC S3b)', () => {
  it('keeps the old close frame and accepts each arm with its claim generation', () => {
    expect(parses(restore({ close }))).toBe(true);
    expect(parses(restore({ close, generation: 'cg_g3' }))).toBe(true);
    expect(parses(restore({ claim, generation: 'cg_g3' }))).toBe(true);
    // The unscoped Sandbox restore is unchanged.
    expect(parses({ kind: 'sandbox.restore-admission', sandboxRuntimeId: 'sandbox-g3' })).toBe(
      true
    );
  });

  it('refuses a claim arm without a generation, a frame with both arms and any unknown field', () => {
    expect(parses(restore({ claim }))).toBe(false);
    expect(parses(restore({ claim, generation: '' }))).toBe(false);
    expect(parses(restore({ close, claim, generation: 'cg_g3' }))).toBe(false);
    expect(parses(restore({ generation: 'cg_g3' }))).toBe(false);
    expect(parses(restore({ claim: { ...claim, sequence: 4 }, generation: 'cg_g3' }))).toBe(false);
    expect(
      parses(
        restore({ claim, generation: 'cg_g3', rollback: { sandboxBindingRef: 'sandbox-binding' } })
      )
    ).toBe(false);
  });

  it('fails closed on the new arm and the new field under the codec of an older binary', () => {
    expect(preG3Restore.safeParse(restore({ close })).success).toBe(true);
    expect(preG3Restore.safeParse(restore({ claim, generation: 'cg_g3' })).success).toBe(false);
    expect(preG3Restore.safeParse(restore({ close, generation: 'cg_g3' })).success).toBe(false);
  });

  it('requires the claim generation on an idle-capture claim and refuses it on no other claim field', () => {
    const idleClaim = {
      kind: 'harness.claim-idle-capture-drain',
      harnessInstanceId: 'harness-g3',
      harnessBindingRef: 'harness-binding-g3',
      agentSessionId: 'as-g3',
      agentSessionRuntimeBindingId: 'binding-g3',
      attemptId: 'attempt-g3',
      sandboxBindingRef: 'sandbox-binding-g3',
      originPhysicalEpoch: 'e'.repeat(64),
      claimedAt: '2098-08-21T00:00:01.000Z',
    };
    // An older Main sends no generation: the current Worker refuses the claim.
    expect(parses(idleClaim)).toBe(false);
    expect(parses({ ...idleClaim, claimGeneration: 'cg_g3' })).toBe(true);
    expect(parses({ ...idleClaim, claimGeneration: 'cg_g3', generation: 'cg_g3' })).toBe(false);
  });
});
