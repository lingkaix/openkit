import { describe, expect, it } from 'vitest';
import { selectHarnessLogin } from './login-selection.js';

type SelectionInput = Parameters<typeof selectHarnessLogin>[0];
type Candidate = SelectionInput['eligible'][number];

const now = 1_800_000_000_000;

/** Builds only the authorized, material-free projection accepted by the selector. */
function login(referenceId: string, changes: Partial<Candidate> = {}): Candidate {
  return {
    referenceId,
    accountId: `account-${referenceId}`,
    ownership: 'own',
    materialGeneration: 3,
    quarantined: false,
    refreshBusy: false,
    ...changes,
  };
}

/** Supplies a canonical observation for the fixture's current material generation. */
function quota(state: 'unknown' | 'available' | 'exhausted'): NonNullable<Candidate['quota']> {
  return { state, materialGeneration: 3, observedAt: now - 1_000 };
}

// Owner: Vault And Secret Injection, Harness Subscription Logins, Selection And Activation.
// The accepted swap/quota study Part 3 forbids treating an elapsed reset as recovery.
describe('harness Login default selection', () => {
  it.each([
    { name: 'missing quota', observation: undefined },
    { name: 'unknown quota after a failed read', observation: quota('unknown') },
    { name: 'observed available quota', observation: quota('available') },
  ])('selects an authorized Login with $name', ({ observation }) => {
    expect(
      selectHarnessLogin({
        eligible: [login('candidate', observation === undefined ? {} : { quota: observation })],
        threadBinding: null,
        trigger: 'use',
        now,
      })
    ).toEqual({ kind: 'target', referenceId: 'candidate' });
  });

  // Owner: Vault Secret Injection, account-wide exhaustion restricts independently authorized use.
  it.each([
    { name: 'missing', observation: undefined },
    { name: 'unknown', observation: quota('unknown') },
    { name: 'available', observation: quota('available') },
  ])(
    'restricts canonical account exhaustion without rewriting own $name quota',
    ({ observation }) => {
      const original = login('candidate', observation ? { quota: observation } : {});
      const unchanged = structuredClone(original);
      const restricted = { ...original, accountExhausted: true as const };
      const fallback = login('fallback', { ownership: 'workspace-shared' });
      for (const threadBinding of [null, { referenceId: original.referenceId }]) {
        expect(
          selectHarnessLogin({
            eligible: [restricted, fallback],
            threadBinding,
            trigger: 'use',
            preferredReferenceId: original.referenceId,
            now,
          })
        ).toEqual({ kind: 'target', referenceId: fallback.referenceId });
        expect(
          selectHarnessLogin({
            eligible: [restricted],
            threadBinding,
            trigger: 'use',
            now,
          })
        ).toEqual({ kind: 'unavailable' });
      }
      expect(restricted.quota).toBe(original.quota);
      expect(original).toEqual(unchanged);
      expect('accountExhausted' in original).toBe(false);
    }
  );

  it('never widens selectable identities when any subset gains the account restriction', () => {
    const eligible = [
      login('own'),
      login('shared', { ownership: 'workspace-shared' }),
      login('quarantined', { quarantined: true }),
      login('busy', { refreshBusy: true }),
      login('exhausted', { quota: quota('exhausted') }),
    ];
    const unchanged = structuredClone(eligible);
    const originallySelectable = new Set(
      eligible
        .filter(
          (candidate) =>
            selectHarnessLogin({ eligible: [candidate], threadBinding: null, trigger: 'use', now })
              .kind === 'target'
        )
        .map((candidate) => candidate.referenceId)
    );
    expect([...originallySelectable]).toEqual(['own', 'shared']);
    for (let mask = 0; mask < 2 ** eligible.length; mask += 1) {
      const restricted = eligible.map((candidate, index) =>
        mask & (1 << index) ? { ...candidate, accountExhausted: true as const } : candidate
      );
      const result = selectHarnessLogin({
        eligible: restricted,
        threadBinding: null,
        trigger: 'explicit-request',
        now,
      });
      if (result.kind !== 'unavailable') {
        expect(originallySelectable.has(result.referenceId)).toBe(true);
        expect(
          restricted.find((candidate) => candidate.referenceId === result.referenceId)
            ?.accountExhausted
        ).toBeUndefined();
      }
      expect(restricted.map((candidate) => candidate.referenceId)).toEqual(
        eligible.map((candidate) => candidate.referenceId)
      );
    }
    expect(eligible).toEqual(unchanged);
  });

  it.each([
    { name: 'no authorized candidates', eligible: [] },
    { name: 'quarantined', eligible: [login('candidate', { quarantined: true })] },
    { name: 'conflicting refresh owner', eligible: [login('candidate', { refreshBusy: true })] },
    {
      name: 'known exhausted quota',
      eligible: [login('candidate', { quota: quota('exhausted') })],
    },
  ])('reports unavailable for $name', ({ eligible }) => {
    expect(selectHarnessLogin({ eligible, threadBinding: null, trigger: 'use', now })).toEqual({
      kind: 'unavailable',
    });
  });

  it('keeps working Thread affinity ahead of own-first preference', () => {
    expect(
      selectHarnessLogin({
        eligible: [login('own'), login('bound', { ownership: 'workspace-shared' })],
        threadBinding: { referenceId: 'bound' },
        trigger: 'use',
        now,
      })
    ).toEqual({ kind: 'keep', referenceId: 'bound' });
  });

  it('does not retain a binding absent from the authorized candidates', () => {
    expect(
      selectHarnessLogin({
        eligible: [login('authorized')],
        threadBinding: { referenceId: 'absent' },
        trigger: 'use',
        now,
      })
    ).toEqual({ kind: 'target', referenceId: 'authorized' });
    expect(
      selectHarnessLogin({
        eligible: [],
        threadBinding: { referenceId: 'absent' },
        trigger: 'use',
        now,
      })
    ).toEqual({ kind: 'unavailable' });
  });

  it.each([
    { name: 'own order', blocked: [], expected: 'own-z' },
    { name: 'next own Login', blocked: ['own-z'], expected: 'own-a' },
    { name: 'shared order after own Logins', blocked: ['own-z', 'own-a'], expected: 'shared-z' },
    {
      name: 'next shared Login',
      blocked: ['own-z', 'own-a', 'shared-z'],
      expected: 'shared-a',
    },
  ])('preserves supplied order within each ownership class: $name', ({ blocked, expected }) => {
    const eligible = [
      login('shared-z', { ownership: 'workspace-shared' }),
      login('own-z'),
      login('shared-a', { ownership: 'workspace-shared', quota: quota('available') }),
      login('own-a', { quota: quota('available') }),
    ].map((candidate) => ({
      ...candidate,
      quarantined: blocked.includes(candidate.referenceId),
    }));

    expect(selectHarnessLogin({ eligible, threadBinding: null, trigger: 'use', now })).toEqual({
      kind: 'target',
      referenceId: expected,
    });
  });

  it.each(['revoked', 'quota-exhausted', 'error', 'explicit-request'] as const)(
    'leaves the outgoing Login on %s even when it otherwise appears usable',
    (trigger) => {
      const input = {
        eligible: [login('outgoing'), login('replacement')],
        threadBinding: { referenceId: 'outgoing' },
        trigger,
        now,
      };
      expect(selectHarnessLogin(input)).toEqual({ kind: 'target', referenceId: 'replacement' });
      expect(selectHarnessLogin({ ...input, eligible: [login('outgoing')] })).toEqual({
        kind: 'unavailable',
      });
    }
  );

  it.each(['revoked', 'error', 'explicit-request'] as const)(
    'allows another family of the same account on %s',
    (trigger) => {
      expect(
        selectHarnessLogin({
          eligible: [
            login('outgoing', { accountId: 'same-account' }),
            login('sibling', { accountId: 'same-account' }),
          ],
          threadBinding: { referenceId: 'outgoing' },
          trigger,
          now,
        })
      ).toEqual({ kind: 'target', referenceId: 'sibling' });
    }
  );

  it('applies a quota-exhausted trigger to every Login of the outgoing account', () => {
    const input: SelectionInput = {
      eligible: [
        login('outgoing', { accountId: 'same-account' }),
        login('sibling', { accountId: 'same-account', ownership: 'workspace-shared' }),
      ],
      threadBinding: { referenceId: 'outgoing' },
      trigger: 'quota-exhausted',
      now,
    };

    expect(selectHarnessLogin(input)).toEqual({ kind: 'unavailable' });
    expect(
      selectHarnessLogin({ ...input, eligible: [...input.eligible, login('other-account')] })
    ).toEqual({ kind: 'target', referenceId: 'other-account' });
  });

  it.each([false, true])(
    'applies observed account exhaustion independently of candidate order (source first: %s)',
    (sourceFirst) => {
      const source = login('exhausted', { accountId: 'same-account', quota: quota('exhausted') });
      const sibling = login('sibling', {
        accountId: 'same-account',
        ownership: 'workspace-shared',
      });
      const eligible = sourceFirst ? [source, sibling] : [sibling, source];

      expect(
        selectHarnessLogin({
          eligible,
          threadBinding: { referenceId: 'sibling' },
          trigger: 'use',
          now,
        })
      ).toEqual({ kind: 'unavailable' });
    }
  );

  it.each([2, 4])(
    'ignores exhaustion from mismatched material generation %s for affinity and account peers',
    (materialGeneration) => {
      const eligible = [
        login('bound', {
          accountId: 'same-account',
          quota: { ...quota('exhausted'), materialGeneration },
        }),
        login('sibling', { accountId: 'same-account' }),
      ];

      expect(
        selectHarnessLogin({
          eligible,
          threadBinding: { referenceId: 'bound' },
          trigger: 'use',
          now,
        })
      ).toEqual({ kind: 'keep', referenceId: 'bound' });
      expect(
        selectHarnessLogin({
          eligible,
          threadBinding: { referenceId: 'bound' },
          trigger: 'error',
          now,
        })
      ).toEqual({ kind: 'target', referenceId: 'sibling' });
    }
  );

  it('does not infer quota recovery from an elapsed reset or observation age', () => {
    expect(
      selectHarnessLogin({
        eligible: [
          login('exhausted', {
            quota: { ...quota('exhausted'), observedAt: now - 120_000, resetsAt: now - 1 },
          }),
        ],
        threadBinding: { referenceId: 'exhausted' },
        trigger: 'use',
        now,
      })
    ).toEqual({ kind: 'unavailable' });
  });

  it.each([
    { elapsed: 59_999, expected: { kind: 'unavailable' } },
    { elapsed: 60_000, expected: { kind: 'target', referenceId: 'returning' } },
  ])('enforces the fixed re-entry boundary at $elapsed ms', ({ elapsed, expected }) => {
    expect(
      selectHarnessLogin({
        eligible: [login('returning', { lastLeftAt: now - elapsed })],
        threadBinding: null,
        trigger: 'use',
        now,
      })
    ).toEqual(expected);
  });

  it.each([
    { name: 'quarantined', changes: { quarantined: true } },
    { name: 'refresh-busy', changes: { refreshBusy: true } },
    { name: 'exhausted', changes: { quota: quota('exhausted') } },
  ])('never retains $name affinity while the alternative cools down', ({ changes }) => {
    const eligible = [login('outgoing', changes), login('returning', { lastLeftAt: now - 59_999 })];
    const input: SelectionInput = {
      eligible,
      threadBinding: { referenceId: 'outgoing' },
      trigger: 'use',
      now,
    };

    expect(selectHarnessLogin(input)).toEqual({ kind: 'unavailable' });
    expect(selectHarnessLogin({ ...input, eligible: [...eligible, login('ready')] })).toEqual({
      kind: 'target',
      referenceId: 'ready',
    });
  });

  it('is deterministic over frozen projections without changing input or retaining selection state', () => {
    const input = Object.freeze({
      eligible: Object.freeze([
        Object.freeze(login('shared', { ownership: 'workspace-shared' })),
        Object.freeze(login('own', { quota: Object.freeze(quota('unknown')) })),
      ]),
      threadBinding: Object.freeze({ referenceId: 'shared' }),
      trigger: 'error' as const,
      now,
    });
    const before = structuredClone(input);

    expect(selectHarnessLogin(input)).toEqual({ kind: 'target', referenceId: 'own' });
    expect(selectHarnessLogin({ eligible: [], threadBinding: null, trigger: 'use', now })).toEqual({
      kind: 'unavailable',
    });
    expect(selectHarnessLogin(input)).toEqual({ kind: 'target', referenceId: 'own' });
    expect(input).toEqual(before);
  });

  it.each([
    {
      name: 'eligible shared preference at the re-entry boundary',
      preferredReferenceId: 'preferred',
      candidates: [login('preferred', { ownership: 'workspace-shared', lastLeftAt: now - 60_000 })],
      expectedReferenceId: 'preferred',
    },
    {
      name: 'preference absent from the authorized set',
      preferredReferenceId: 'preferred',
      candidates: [],
      expectedReferenceId: 'own-fallback',
    },
    {
      name: 'refresh-busy preference',
      preferredReferenceId: 'preferred',
      candidates: [login('preferred', { refreshBusy: true })],
      expectedReferenceId: 'own-fallback',
    },
    {
      name: 'preference one millisecond before re-entry',
      preferredReferenceId: 'preferred',
      candidates: [login('preferred', { lastLeftAt: now - 59_999 })],
      expectedReferenceId: 'own-fallback',
    },
    {
      name: 'quarantined preference',
      preferredReferenceId: 'preferred',
      candidates: [login('preferred', { quarantined: true })],
      expectedReferenceId: 'own-fallback',
    },
    {
      name: 'exhausted preference',
      preferredReferenceId: 'preferred',
      candidates: [login('preferred', { quota: quota('exhausted') })],
      expectedReferenceId: 'own-fallback',
    },
    {
      name: 'preferred account exhausted by another authorized family',
      preferredReferenceId: 'preferred',
      candidates: [
        login('preferred', { accountId: 'same-account', quota: quota('available') }),
        login('exhausted-family', { accountId: 'same-account', quota: quota('exhausted') }),
      ],
      expectedReferenceId: 'own-fallback',
    },
    {
      name: 'outgoing Login is the preference',
      preferredReferenceId: 'outgoing',
      candidates: [],
      expectedReferenceId: 'own-fallback',
    },
  ])('applies preference before normal replacement order: $name', (row) => {
    const input: SelectionInput = {
      eligible: [
        login('shared-fallback', { ownership: 'workspace-shared' }),
        login('own-fallback'),
        login('outgoing'),
        ...row.candidates,
      ],
      threadBinding: { referenceId: 'outgoing' },
      trigger: 'explicit-request',
      now,
    };
    expect(selectHarnessLogin(input)).toEqual({ kind: 'target', referenceId: 'own-fallback' });
    // This transient owner input is structural so OLD reaches the actual selector.
    const preferred: SelectionInput & { readonly preferredReferenceId: string } = {
      ...input,
      preferredReferenceId: row.preferredReferenceId,
    };
    expect(selectHarnessLogin(preferred)).toEqual({
      kind: 'target',
      referenceId: row.expectedReferenceId,
    });
  });

  it('keeps working use affinity ahead of another eligible preference', () => {
    const input: SelectionInput & { readonly preferredReferenceId: string } = {
      eligible: [
        login('preferred'),
        login('bound', { ownership: 'workspace-shared', lastLeftAt: now - 59_999 }),
      ],
      threadBinding: { referenceId: 'bound' },
      trigger: 'use',
      preferredReferenceId: 'preferred',
      now,
    };
    expect(selectHarnessLogin(input)).toEqual({ kind: 'keep', referenceId: 'bound' });
  });

  it('falls back to shared order when the preference and own candidates are unusable', () => {
    const input: SelectionInput & { readonly preferredReferenceId: string } = {
      eligible: [
        login('shared-first', { ownership: 'workspace-shared' }),
        login('own', { refreshBusy: true }),
        login('preferred', { quarantined: true }),
        login('shared-next', { ownership: 'workspace-shared' }),
      ],
      threadBinding: null,
      trigger: 'explicit-request',
      preferredReferenceId: 'preferred',
      now,
    };
    expect(selectHarnessLogin(input)).toEqual({ kind: 'target', referenceId: 'shared-first' });
  });
});
