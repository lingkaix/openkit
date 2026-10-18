import {
  allocateEntityId,
  type InterceptionInvocation,
  type InterceptionReference,
  type InterceptionStatement,
} from '@openkit/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  createInterceptionExecutor,
  type InterceptionExecution,
  resolveInterceptionBinding,
} from './interception.js';

const owner = { kind: 'workspace' as const, workspaceId: allocateEntityId('ws') };
const actor = { kind: 'user' as const, id: allocateEntityId('usr') };
const ref = (id: string): InterceptionReference => ({
  kind: 'record',
  owner,
  family: 'fixture',
  id,
  version: '1',
});
const source = { kind: 'record' as const, owner, family: 'policy', id: 'current', version: '1' };
const statement: InterceptionStatement = {
  schemaVersion: 1,
  id: 'tool-policy',
  point: 'P3',
  mode: 'gate',
  owner,
  subject: actor,
  action: 'tool.use',
  resource: source,
  participant: { id: 'deterministic', version: '1' },
  inputContract: { id: 'tool-input', version: '1' },
  outputContract: { id: 'tool-output', version: '1' },
  order: 0,
  timeoutMs: 10,
  circuit: { failureThreshold: 1, resetAfterMs: 100 },
  onUnavailable: 'error',
  author: actor,
  delegation: null,
};
const binding = (id: string, mode: InterceptionStatement['mode']) =>
  resolveInterceptionBinding({ ...statement, id, mode }, source);

function execution(overrides: Partial<InterceptionExecution<string>> = {}) {
  const records: InterceptionInvocation[] = [];
  const release = vi.fn(() => 'dispatched');
  return {
    records,
    release,
    input: {
      nativeBinding: binding('native', 'gate'),
      bindings: [],
      input: { reference: ref('original'), value: { operation: 'read' } },
      actor,
      record: (record: InterceptionInvocation) => {
        records.push(record);
      },
      isCurrent: () => true,
      authorize: () => true,
      resolveOutput: () => ({ operation: 'replacement' }),
      validateInput: () => {},
      finalPolicy: () => 'allow' as const,
      release,
      ...overrides,
    } satisfies InterceptionExecution<string>,
  };
}

describe('common interception executor', () => {
  it('uses one deterministic provider for transform, advice and gate, then final Policy and synchronous release', async () => {
    const order: string[] = [];
    const fixture = execution({
      bindings: [
        binding('gate', 'gate'),
        binding('advice', 'advise'),
        binding('transform', 'transform'),
        binding('observe', 'observe'),
      ],
      finalPolicy: (value) => {
        order.push('kernel');
        expect(value).toEqual({ operation: 'replacement' });
        return 'allow';
      },
      release: () => {
        order.push('effect');
        return 'dispatched';
      },
    });
    const executor = createInterceptionExecutor({
      invoke: async (selected, input) => {
        order.push(selected.mode);
        if (selected.mode !== 'transform') expect(input.reference).toEqual(ref('replacement'));
        return {
          bindingVersion: selected.version,
          input: input.reference,
          outcome:
            selected.mode === 'transform'
              ? 'transformed'
              : selected.mode === 'advise'
                ? 'advised'
                : selected.mode === 'observe'
                  ? 'observed'
                  : 'allowed',
          output: selected.mode === 'transform' ? ref('replacement') : null,
        };
      },
    });
    expect(await executor.execute(fixture.input)).toEqual({
      outcome: 'allowed',
      released: 'dispatched',
    });
    expect(order).toEqual(['transform', 'advise', 'gate', 'observe', 'kernel', 'effect']);
    expect(fixture.records[0]).toMatchObject({
      input: ref('original'),
      output: ref('replacement'),
      outcome: 'transformed',
    });
    expect(fixture.records.at(-1)).toMatchObject({ input: ref('replacement'), outcome: 'allowed' });
  });

  it('does not let advice mutate input or override the final Kernel denial', async () => {
    const fixture = execution({
      bindings: [binding('advice', 'advise')],
      finalPolicy: (value) => {
        expect(value).toEqual({ operation: 'read' });
        return 'deny';
      },
    });
    const executor = createInterceptionExecutor({
      invoke: async (selected, input) => {
        (input.value as { operation: string }).operation = 'write';
        return {
          bindingVersion: selected.version,
          input: input.reference,
          outcome: 'advised',
          output: null,
        };
      },
    });
    expect(await executor.execute(fixture.input)).toMatchObject({
      outcome: 'refused',
      reasonCode: 'policy-denied',
    });
    expect(fixture.release).not.toHaveBeenCalled();
  });

  it('preserves a valid gate refusal separately from unavailability', async () => {
    const fixture = execution({ bindings: [binding('gate', 'gate')] });
    const executor = createInterceptionExecutor({
      invoke: async (selected, input) => ({
        bindingVersion: selected.version,
        input: input.reference,
        outcome: 'refused',
        output: null,
      }),
    });
    expect(await executor.execute(fixture.input)).toMatchObject({ outcome: 'refused' });
    expect(fixture.records[0]?.outcome).toBe('refused');
    expect(fixture.release).not.toHaveBeenCalled();
  });

  it('bounds timeout, records open circuit without reinvocation and permits one later probe', async () => {
    let clock = 0;
    let recover = false;
    const invoke = vi.fn(async (selected, input) =>
      recover
        ? {
            bindingVersion: selected.version,
            input: input.reference,
            outcome: 'allowed' as const,
            output: null,
          }
        : new Promise<never>(() => {})
    );
    const executor = createInterceptionExecutor({ now: () => clock, invoke });
    const fixture = execution({ bindings: [binding('gate', 'gate')] });
    expect(await executor.execute(fixture.input)).toMatchObject({
      outcome: 'unavailable',
      reasonCode: 'timeout',
    });
    expect(await executor.execute(fixture.input)).toMatchObject({
      outcome: 'unavailable',
      reasonCode: 'open-circuit',
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    recover = true;
    clock = 101;
    expect(await executor.execute(fixture.input)).toMatchObject({ outcome: 'allowed' });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(fixture.records.map((record) => record.outcome)).toEqual([
      'unavailable',
      'unavailable',
      'allowed',
      'allowed',
    ]);
  });

  it('rejects a stale result and ungranted transform without releasing the effect', async () => {
    const fixture = execution({ bindings: [binding('gate', 'gate')] });
    const executor = createInterceptionExecutor({
      invoke: async (selected, input) => ({
        bindingVersion: `${selected.version}-old`,
        input: input.reference,
        outcome: 'allowed',
        output: null,
      }),
    });
    expect(await executor.execute(fixture.input)).toMatchObject({ outcome: 'unavailable' });
    const ungranted = execution({
      bindings: [binding('transform', 'transform')],
      authorize: () => false,
    });
    expect(await executor.execute(ungranted.input)).toMatchObject({
      outcome: 'unavailable',
      reasonCode: 'authority-unavailable',
    });
    expect(ungranted.release).not.toHaveBeenCalled();
  });

  it('does not dispatch when durable evidence fails and does not fabricate a Policy denial', async () => {
    const fixture = execution({
      record: () => {
        throw new Error('storage unavailable');
      },
    });
    const executor = createInterceptionExecutor({ invoke: vi.fn() });
    expect(await executor.execute(fixture.input)).toEqual({
      outcome: 'error',
      reasonCode: 'evidence-write-failed',
    });
    expect(fixture.release).not.toHaveBeenCalled();
    const failedPolicy = execution({
      finalPolicy: () => {
        throw new Error('authority read unavailable');
      },
    });
    expect(await executor.execute(failedPolicy.input)).toEqual({
      outcome: 'error',
      reasonCode: 'policy-unavailable',
    });
    expect(failedPolicy.records[0]?.outcome).toBe('error');
  });

  it('has no await between the final check, evidence and dispatch', async () => {
    let current = true;
    const fixture = execution({
      record: () => {
        queueMicrotask(() => {
          current = false;
        });
      },
      finalPolicy: () => (current ? 'allow' : 'deny'),
      release: () => {
        expect(current).toBe(true);
        return 'dispatched';
      },
    });
    expect(
      await createInterceptionExecutor({ invoke: vi.fn() }).execute(fixture.input)
    ).toMatchObject({ outcome: 'allowed' });
  });

  it('passes the existing lease facts to a deterministic participant without creating lease authority', async () => {
    const lease = {
      knowledgeBaseId: 'owner-defined-kb',
      mount: 'default',
      prefix: 'admissions/',
      mode: 'read-only',
      expiresAt: '2026-10-18T01:00:00.000Z',
    };
    const fixture = execution({
      input: { reference: { ...source, family: 'policy-grant', id: 'lease' }, value: lease },
      bindings: [binding('lease-assessment', 'advise')],
      finalPolicy: () => 'deny',
    });
    const invoke = vi.fn(async (selected, input) => {
      expect(input.value).toEqual(lease);
      return {
        bindingVersion: selected.version,
        input: input.reference,
        outcome: 'advised' as const,
        output: null,
      };
    });
    expect(await createInterceptionExecutor({ invoke }).execute(fixture.input)).toMatchObject({
      outcome: 'refused',
    });
    expect(fixture.release).not.toHaveBeenCalled();
  });
});
