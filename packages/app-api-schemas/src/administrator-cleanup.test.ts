import { Buffer } from 'node:buffer';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ADMINISTRATOR_CLEANUP_MAX_BYTES,
  ADMINISTRATOR_CLEANUP_MAX_ENTRIES,
  ADMINISTRATOR_CLEANUP_SOURCE_OWNERS,
  ADMINISTRATOR_CLEANUP_SOURCES,
  type AdministratorCleanupAgentSessionBindingItem,
  AdministratorCleanupAgentSessionBindingItemSchema,
  type AdministratorCleanupBackendSessionItem,
  AdministratorCleanupBackendSessionItemSchema,
  type AdministratorCleanupExecutionAttemptItem,
  AdministratorCleanupExecutionAttemptItemSchema,
  type AdministratorCleanupItem,
  AdministratorCleanupItemSchema,
  type AdministratorCleanupReadResponse,
  AdministratorCleanupReadResponseSchema,
  type AdministratorCleanupRuntimeItem,
  type AdministratorCleanupSandboxRuntimeItem,
  AdministratorCleanupSandboxRuntimeItemSchema,
  type AdministratorCleanupSource,
  type AdministratorCleanupSourceObservation,
  AdministratorCleanupSourceObservationSchema,
  AdministratorCleanupSourceSchema,
  type AdministratorCleanupWorkerStorageItem,
  AdministratorCleanupWorkerStorageItemSchema,
  type AdministratorCleanupWorkspaceDeletionItem,
  AdministratorCleanupWorkspaceDeletionItemSchema,
} from './administrator-cleanup.js';

const OBSERVED_AT = '2026-10-16T00:00:00.000Z';
const SOURCE_TIME = '2026-10-15T12:00:00.000Z';
const SOURCES = [
  'workspace-deletion',
  'execution-attempt',
  'backend-session',
  'agent-session-binding',
  'sandbox-runtime',
  'worker-storage',
] as const;
const OWNERS = {
  'workspace-deletion': 'docs/specs/20260715-multi_user_workspace_system.md',
  'execution-attempt': 'docs/specs/20260703-durable_scheduler_design.md',
  'backend-session': 'docs/specs/20260802-nanohost_runtime_and_transport.md',
  'agent-session-binding': 'docs/specs/20260802-nanohost_runtime_and_transport.md',
  'sandbox-runtime': 'docs/specs/20260802-nanohost_runtime_and_transport.md',
  'worker-storage': 'docs/specs/20260910-persistent_worker_volumes.md',
} as const;

const branches = {
  'workspace-deletion': {
    target: { kind: 'workspace-deletion', workspaceId: 'ws_cleanup', requestId: 'request_cleanup' },
    state: { phase: 'deleted', retainedStaging: true, cleanedAt: null },
  },
  'execution-attempt': {
    target: {
      kind: 'execution-attempt',
      attemptId: 'attempt_cleanup',
      workspaceId: 'ws_cleanup',
      threadId: 'thread_cleanup',
      turnId: 'turn_cleanup',
      agentSessionId: null,
    },
    state: { phase: 'closing', disposition: 'unknown' },
  },
  'backend-session': {
    target: {
      kind: 'backend-session',
      attemptId: 'attempt_cleanup',
      workspaceId: 'ws_cleanup',
      threadId: 'thread_cleanup',
      turnId: 'turn_cleanup',
      agentSessionId: 'session_cleanup',
    },
    state: {
      state: 'cleanup-failed',
      workspaceHandoffState: 'pending',
      physicalCleanedAt: null,
      physicalEpochRelation: 'unknown',
    },
  },
  'agent-session-binding': {
    target: {
      kind: 'agent-session-binding',
      agentSessionRuntimeBindingId: 'binding_cleanup',
      agentSessionId: 'session_cleanup',
      workspaceId: 'ws_cleanup',
      threadId: 'thread_cleanup',
    },
    state: { lifecycleState: 'closing', cleanupState: 'unknown' },
  },
  'sandbox-runtime': {
    target: {
      kind: 'sandbox-runtime',
      sandboxRuntimeId: 'sandbox_cleanup',
      runtimeTargetId: 'runtime_cleanup',
    },
    state: {
      lifecycleState: 'failed',
      healthState: 'unknown',
      drainState: 'draining',
      cleanupState: 'unknown',
      physicalEpochRelation: 'unknown',
    },
  },
  'worker-storage': {
    target: {
      kind: 'worker-storage',
      storageRef: 'storage_cleanup',
      workspaceId: 'ws_cleanup',
      runtimeTargetId: 'runtime_cleanup',
    },
    state: { state: 'purge-pending', revision: 1, purgedAt: null },
  },
};

/** Creates observations from the existing owners, without claiming those identifiers are authorized. */
function item(source: AdministratorCleanupSource) {
  const branch = structuredClone(branches[source]);
  return {
    source,
    sourceOwner: OWNERS[source],
    target: branch.target,
    state: branch.state,
    sourceUpdatedAt: SOURCE_TIME as string | null,
    observedAt: OBSERVED_AT,
    evidence: {
      kind: 'recorded',
      recordedAt: SOURCE_TIME,
      reference: structuredClone(branch.target),
    },
    nextInspection: {
      kind: 'source-record',
      sourceOwner: OWNERS[source],
      target: structuredClone(branch.target),
    },
  };
}

/** Reserves the complete six-source envelope even when no records were observed. */
function response(items = SOURCES.map(item)) {
  return {
    observedAt: OBSERVED_AT,
    items,
    sources: SOURCES.map((source) => ({
      source,
      availability: 'available',
      incomplete: false,
      reasons: [] as string[],
    })),
    incomplete: false,
  };
}

/** Pads a known opaque reference, including its two exact mirrors, to a fixed UTF-8 response size. */
function responseBytes(bytes: number) {
  const observation = item('worker-storage');
  const result = response([observation]);
  const gap = bytes - Buffer.byteLength(JSON.stringify(result), 'utf8');
  const singleBytes = Math.floor(gap / 3);
  // The three copies account for multiples of three; revision's digit count fills the remainder.
  observation.state = { ...branches['worker-storage'].state, revision: 10 ** (gap % 3) };
  const storageRef = `storage_cleanup${'界'.repeat(Math.floor(singleBytes / 3))}${'x'.repeat(singleBytes % 3)}`;
  for (const target of [
    observation.target,
    observation.evidence.reference,
    observation.nextInspection.target,
  ]) {
    Object.assign(target, { storageRef });
  }
  expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBe(bytes);
  return result;
}

describe('administrator cleanup shared schemas', () => {
  it('exports the exact bounded six-source contract and source owners', () => {
    expect(ADMINISTRATOR_CLEANUP_MAX_ENTRIES).toBe(100);
    expect(ADMINISTRATOR_CLEANUP_MAX_BYTES).toBe(262144);
    expect(ADMINISTRATOR_CLEANUP_SOURCES).toEqual(SOURCES);
    expect(ADMINISTRATOR_CLEANUP_SOURCE_OWNERS).toEqual(OWNERS);
    for (const source of SOURCES)
      expect(AdministratorCleanupSourceSchema.parse(source)).toBe(source);
    expect(AdministratorCleanupSourceSchema.safeParse('orphan-files').success).toBe(false);
  });

  it.each([
    ['workspace-deletion', AdministratorCleanupWorkspaceDeletionItemSchema],
    ['execution-attempt', AdministratorCleanupExecutionAttemptItemSchema],
    ['backend-session', AdministratorCleanupBackendSessionItemSchema],
    ['agent-session-binding', AdministratorCleanupAgentSessionBindingItemSchema],
    ['sandbox-runtime', AdministratorCleanupSandboxRuntimeItemSchema],
    ['worker-storage', AdministratorCleanupWorkerStorageItemSchema],
  ] as const)('preserves the exact %s branch and nullable source timestamp', (source, schema) => {
    const observation = item(source);
    expect(schema.parse(observation)).toEqual(observation);
    expect(AdministratorCleanupItemSchema.parse(observation)).toEqual(observation);
    observation.sourceUpdatedAt = null;
    expect(schema.parse(observation).sourceUpdatedAt).toBeNull();
    const { sourceUpdatedAt: _omitted, ...missingTimestamp } = observation;
    expect(schema.safeParse(missingTimestamp).success).toBe(false);
    expect(schema.safeParse(item(SOURCES[(SOURCES.indexOf(source) + 1) % 6]!)).success).toBe(false);
  });

  it('exports source-specific types and the five-source runtime union', () => {
    expectTypeOf<AdministratorCleanupWorkspaceDeletionItem>().toEqualTypeOf<
      Extract<AdministratorCleanupItem, { source: 'workspace-deletion' }>
    >();
    expectTypeOf<AdministratorCleanupExecutionAttemptItem>().toEqualTypeOf<
      Extract<AdministratorCleanupItem, { source: 'execution-attempt' }>
    >();
    expectTypeOf<AdministratorCleanupBackendSessionItem>().toEqualTypeOf<
      Extract<AdministratorCleanupItem, { source: 'backend-session' }>
    >();
    expectTypeOf<AdministratorCleanupAgentSessionBindingItem>().toEqualTypeOf<
      Extract<AdministratorCleanupItem, { source: 'agent-session-binding' }>
    >();
    expectTypeOf<AdministratorCleanupSandboxRuntimeItem>().toEqualTypeOf<
      Extract<AdministratorCleanupItem, { source: 'sandbox-runtime' }>
    >();
    expectTypeOf<AdministratorCleanupWorkerStorageItem>().toEqualTypeOf<
      Extract<AdministratorCleanupItem, { source: 'worker-storage' }>
    >();
    expectTypeOf<AdministratorCleanupRuntimeItem>().toEqualTypeOf<
      Exclude<AdministratorCleanupItem, { source: 'workspace-deletion' }>
    >();
    expectTypeOf<
      AdministratorCleanupReadResponse['items'][number]
    >().toEqualTypeOf<AdministratorCleanupItem>();
    expectTypeOf<
      AdministratorCleanupSourceObservation['source']
    >().toEqualTypeOf<AdministratorCleanupSource>();
  });

  it.each(
    SOURCES
  )('strips inert nested annotations from %s without exposing an operation', (source) => {
    const known = item(source);
    const decorated = {
      ...known,
      annotation: 'future display metadata',
      target: { ...known.target, label: 'ignored' },
      state: { ...known.state, explanatoryLabel: 'ignored' },
      evidence: {
        ...known.evidence,
        description: 'ignored',
        reference: { ...known.evidence.reference, label: 'ignored' },
      },
      nextInspection: {
        ...known.nextInspection,
        canDelete: true,
        operation: 'invented.cleanup',
        target: { ...known.nextInspection.target, label: 'ignored' },
      },
    };
    expect(AdministratorCleanupItemSchema.parse(decorated)).toEqual(known);
  });

  it.each(
    SOURCES
  )('fails closed for changed %s identity, owner and inspection semantics', (source) => {
    const known = item(source);
    const invalid = [
      { ...known, source: 'future-source' },
      {
        ...known,
        sourceOwner:
          OWNERS['worker-storage'] === known.sourceOwner
            ? OWNERS['workspace-deletion']
            : OWNERS['worker-storage'],
      },
      { ...known, target: { ...known.target, kind: 'future-target' } },
      { ...known, evidence: { ...known.evidence, kind: 'assumed-clean' } },
      { ...known, nextInspection: { ...known.nextInspection, kind: 'operation' } },
      {
        ...known,
        nextInspection: { ...known.nextInspection, sourceOwner: 'docs/specs/unowned.md' },
      },
      { ...known, observedAt: 'not-a-timestamp' },
      { ...known, sourceUpdatedAt: 'not-a-timestamp' },
      { ...known, state: undefined },
      { ...known, evidence: undefined },
      { ...known, nextInspection: undefined },
      { ...known, evidence: { ...known.evidence, recordedAt: 'not-a-timestamp' } },
    ];
    for (const candidate of invalid)
      expect(AdministratorCleanupItemSchema.safeParse(candidate).success).toBe(false);
    for (const field of Object.keys(known.state)) {
      const state = { ...known.state } as Record<string, unknown>;
      delete state[field];
      expect(AdministratorCleanupItemSchema.safeParse({ ...known, state }).success).toBe(false);
    }
    for (const key of Object.keys(known.target).filter((key) => key !== 'kind')) {
      const missing = { ...known.target } as Record<string, unknown>;
      delete missing[key];
      expect(AdministratorCleanupItemSchema.safeParse({ ...known, target: missing }).success).toBe(
        false
      );
      expect(
        AdministratorCleanupItemSchema.safeParse({
          ...known,
          target: { ...known.target, [key]: '' },
        }).success
      ).toBe(false);
      for (const field of ['evidence', 'nextInspection'] as const) {
        const referenceKey = field === 'evidence' ? 'reference' : 'target';
        const candidate = {
          ...known,
          [field]: {
            ...known[field],
            [referenceKey]: { ...known.target, [key]: 'different-identity' },
          },
        };
        expect(AdministratorCleanupItemSchema.safeParse(candidate).success).toBe(false);
      }
    }
  });

  it('requires nullable execution AgentSession lineage but nonnullable backend lineage', () => {
    expect(
      AdministratorCleanupExecutionAttemptItemSchema.parse(item('execution-attempt')).target
        .agentSessionId
    ).toBeNull();
    const backend = item('backend-session');
    expect(
      AdministratorCleanupBackendSessionItemSchema.safeParse({
        ...backend,
        target: { ...backend.target, agentSessionId: null },
      }).success
    ).toBe(false);
  });

  it.each([
    [
      'workspace-deletion',
      'phase',
      [
        'requested',
        'fenced',
        'blocked',
        'deleting',
        'exported',
        'closure-sealed',
        'staged',
        'deleted',
        'cleaned',
      ],
    ],
    ['execution-attempt', 'phase', ['open', 'closing', 'closed']],
    ['execution-attempt', 'disposition', ['not_accepted', 'accepted', 'unknown']],
    [
      'backend-session',
      'state',
      [
        'materializing',
        'materialized',
        'launching',
        'cleanup-pending',
        'cleanup-failed',
        'physical-cleaned',
        'cleaned',
      ],
    ],
    ['backend-session', 'workspaceHandoffState', ['pending', 'complete']],
    ['backend-session', 'physicalEpochRelation', ['same', 'different', 'unknown']],
    [
      'agent-session-binding',
      'lifecycleState',
      ['opening', 'open', 'active', 'closing', 'closed', 'failed'],
    ],
    ['agent-session-binding', 'cleanupState', ['clean', 'pending', 'unknown']],
    ['sandbox-runtime', 'lifecycleState', ['open', 'failed']],
    ['sandbox-runtime', 'healthState', ['ready', 'unknown']],
    ['sandbox-runtime', 'drainState', ['accepting', 'draining']],
    ['sandbox-runtime', 'cleanupState', ['clean', 'unknown']],
    ['sandbox-runtime', 'physicalEpochRelation', ['same', 'different', 'unknown']],
    [
      'worker-storage',
      'state',
      ['idle', 'reserved', 'attached', 'unknown', 'purge-pending', 'purged'],
    ],
  ] as const)('keeps %s.%s in its existing owner vocabulary', (source, field, values) => {
    const known = item(source);
    for (const value of values)
      expect(
        AdministratorCleanupItemSchema.safeParse({
          ...known,
          state: { ...known.state, [field]: value },
        }).success
      ).toBe(true);
    expect(
      AdministratorCleanupItemSchema.safeParse({
        ...known,
        state: { ...known.state, [field]: 'future-state' },
      }).success
    ).toBe(false);
    const state = { ...known.state } as Record<string, unknown>;
    delete state[field];
    expect(AdministratorCleanupItemSchema.safeParse({ ...known, state }).success).toBe(false);
  });

  it('requires positive safe storage revision and required nullable proof times', () => {
    const storage = item('worker-storage');
    for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(
        AdministratorCleanupWorkerStorageItemSchema.safeParse({
          ...storage,
          state: { ...storage.state, revision },
        }).success
      ).toBe(false);
    for (const [source, field] of [
      ['workspace-deletion', 'cleanedAt'],
      ['backend-session', 'physicalCleanedAt'],
      ['worker-storage', 'purgedAt'],
    ] as const) {
      const known = item(source);
      expect(
        AdministratorCleanupItemSchema.safeParse({
          ...known,
          state: { ...known.state, [field]: SOURCE_TIME },
        }).success
      ).toBe(true);
      const state = { ...known.state } as Record<string, unknown>;
      delete state[field];
      expect(AdministratorCleanupItemSchema.safeParse({ ...known, state }).success).toBe(false);
      expect(
        AdministratorCleanupItemSchema.safeParse({
          ...known,
          state: { ...known.state, [field]: 'invalid' },
        }).success
      ).toBe(false);
    }
  });

  it.each([
    'missing',
    'stale',
    'contradictory',
    'unavailable',
  ] as const)('preserves explicit %s evidence without converting it to cleanup certainty', (reason) => {
    const known = item('execution-attempt');
    const observation = {
      ...known,
      state: { phase: 'closed', disposition: 'unknown' },
      evidence: { kind: 'unknown', reason },
    };
    expect(AdministratorCleanupItemSchema.parse(observation)).toEqual(observation);
    expect(
      AdministratorCleanupItemSchema.safeParse({
        ...observation,
        evidence: { kind: 'unknown', reason: 'safe-to-delete' },
      }).success
    ).toBe(false);
    expect(
      AdministratorCleanupItemSchema.safeParse({
        ...known,
        evidence: { kind: 'recorded', recordedAt: SOURCE_TIME },
      }).success
    ).toBe(false);
  });

  it('normalizes one complete observation with all six empty or populated source facts', () => {
    expect(AdministratorCleanupReadResponseSchema.parse(response())).toEqual(response());
    expect(AdministratorCleanupReadResponseSchema.parse(response([]))).toEqual(response([]));
    const annotated = {
      ...response([]),
      description: 'ignored',
      sources: response([]).sources.map((source) => ({ ...source, label: 'ignored' })),
    };
    expect(AdministratorCleanupReadResponseSchema.parse(annotated)).toEqual(response([]));
  });

  it('requires exactly the stable six-source order and the common observation time', () => {
    const known = response();
    for (const sources of [
      known.sources.slice(1),
      [...known.sources, known.sources[0]],
      [...known.sources].reverse(),
      known.sources.map((source, index) => (index === 1 ? known.sources[0] : source)),
    ])
      expect(AdministratorCleanupReadResponseSchema.safeParse({ ...known, sources }).success).toBe(
        false
      );
    expect(
      AdministratorCleanupReadResponseSchema.safeParse({
        ...known,
        items: [{ ...known.items[0]!, observedAt: SOURCE_TIME }],
      }).success
    ).toBe(false);
  });

  it('keeps coverage reasons and aggregate incompleteness consistent without discarding validated observations', () => {
    const reasons = ['count_limit', 'byte_limit', 'source_unavailable', 'source_changed'];
    for (let mask = 0; mask < 16; mask++) {
      const selected = reasons.filter((_, index) => mask & (1 << index));
      const source = {
        source: 'execution-attempt' as const,
        availability: selected.includes('source_unavailable') ? 'unavailable' : 'available',
        incomplete: selected.length > 0,
        reasons: selected,
      };
      expect(AdministratorCleanupSourceObservationSchema.parse(source)).toEqual(source);
      const known = response([item('execution-attempt')]);
      known.sources[1] = source;
      known.incomplete = source.incomplete;
      expect(AdministratorCleanupReadResponseSchema.parse(known)).toEqual(known);
      expect(
        AdministratorCleanupReadResponseSchema.safeParse({
          ...known,
          incomplete: !source.incomplete,
        }).success
      ).toBe(false);
    }
  });

  it('rejects unknown, duplicate or contradictory source coverage values', () => {
    const known = response([]).sources[0]!;
    const invalid = [
      { ...known, source: 'future-source' },
      { ...known, availability: 'unknown' },
      { ...known, incomplete: true },
      { ...known, reasons: ['count_limit'] },
      { ...known, incomplete: true, reasons: ['future-reason'] },
      { ...known, incomplete: true, reasons: ['count_limit', 'count_limit'] },
      { ...known, incomplete: true, reasons: ['source_unavailable'] },
      { ...known, availability: 'unavailable', incomplete: true, reasons: ['source_changed'] },
      { ...known, availability: 'unavailable', incomplete: false, reasons: ['source_unavailable'] },
    ];
    for (const candidate of invalid)
      expect(AdministratorCleanupSourceObservationSchema.safeParse(candidate).success).toBe(false);
  });

  it('applies the inclusive entry limit of 100 across sources rather than per source', () => {
    const items = Array.from({ length: 101 }, (_, index) => {
      const observation = item(SOURCES[index % 6]!);
      const target = {
        ...observation.target,
        ...('workspaceId' in observation.target
          ? { workspaceId: `ws_${index}` }
          : { sandboxRuntimeId: `sandbox_${index}` }),
      };
      return {
        ...observation,
        target,
        evidence: { ...observation.evidence, reference: structuredClone(target) },
        nextInspection: { ...observation.nextInspection, target: structuredClone(target) },
      };
    });
    expect(
      AdministratorCleanupReadResponseSchema.safeParse(response(items.slice(0, 100))).success
    ).toBe(true);
    const excess = response(items);
    for (const source of excess.sources) {
      source.incomplete = true;
      source.reasons = ['count_limit'];
    }
    excess.incomplete = true;
    expect(AdministratorCleanupReadResponseSchema.safeParse(excess).success).toBe(false);
  });

  it.each([
    262143, 262144, 262145,
  ])('accounts for the entire known UTF-8 response at %i bytes', (bytes) => {
    const known = responseBytes(bytes);
    expect(JSON.stringify(known).length).toBeLessThan(bytes);
    expect(AdministratorCleanupReadResponseSchema.safeParse(known).success).toBe(bytes <= 262144);
  });

  it('measures output bytes after stripping unknown annotations', () => {
    const known = responseBytes(262144);
    const annotated = { ...known, ignoredAnnotation: '界'.repeat(100000) };
    expect(Buffer.byteLength(JSON.stringify(annotated), 'utf8')).toBeGreaterThan(262144);
    expect(AdministratorCleanupReadResponseSchema.parse(annotated)).toEqual(known);
  });
});
