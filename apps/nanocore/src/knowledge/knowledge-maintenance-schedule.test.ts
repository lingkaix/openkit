import type { KnowledgeOwnerScope } from '@openkit/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  type KnowledgeMaintenanceScheduleTurn,
  scanDailyKnowledgeMaintenance,
} from './knowledge-maintenance-schedule.js';

const ownerScope: KnowledgeOwnerScope = { kind: 'server' };
const instant = '2026-10-17T00:00:00.000Z';

/** Projects the existing scheduled Turn metadata supplied by the native admission owner. */
function retainedTurn(startedAt: string): KnowledgeMaintenanceScheduleTurn {
  return {
    startedAt,
    internalExecution: {
      roleId: 'knowledge-manager',
      knowledge: { purpose: 'maintenance', ownerScope, trigger: 'schedule' },
    },
  };
}

describe('daily Knowledge Manager scheduling', () => {
  it('keeps omitted and disabled schedules off independently of publication delegation', () => {
    const listTurns = vi.fn(() => []);
    const prepare = vi.fn();
    scanDailyKnowledgeMaintenance({
      now: instant,
      scopes: [
        { ownerScope, enabled: true },
        { ownerScope, enabled: true, schedule: { enabled: false } },
      ],
      listTurns,
      prepare,
      onError: vi.fn(),
    });
    expect(listTurns).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it('retains one daily admission across fresh scans and routes detached execution failure to its Turn owner', async () => {
    const turns: KnowledgeMaintenanceScheduleTurn[] = [
      {
        ...retainedTurn(instant),
        internalExecution: {
          ...retainedTurn(instant).internalExecution!,
          knowledge: { purpose: 'maintenance', ownerScope, trigger: 'request' },
        },
      },
    ];
    const scope = { ownerScope, schedule: { enabled: true } };
    const failure = new Error('Provider unavailable.');
    const fail = vi.fn((error: unknown) => {
      expect(error).toBe(failure);
    });
    let rejectRun!: (error: Error) => void;
    const execute = vi
      .fn(async () => {})
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectRun = reject;
          })
      );
    const prepare = vi.fn((_scope: typeof scope, startedAt: string) => {
      turns.push(retainedTurn(startedAt));
      return { execute, fail };
    });
    const input = {
      now: instant,
      scopes: [scope],
      listTurns: () => turns,
      prepare,
      onError: vi.fn(),
    };
    expect(scanDailyKnowledgeMaintenance(input)).toBeUndefined();
    scanDailyKnowledgeMaintenance({ ...input });
    await Promise.resolve();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    rejectRun(failure);
    await vi.waitFor(() => expect(fail).toHaveBeenCalledTimes(1));
    expect(fail).toHaveBeenCalledWith(failure);
    scanDailyKnowledgeMaintenance({ ...input });
    expect(prepare).toHaveBeenCalledTimes(1);
    // A later UTC day is a new invocation, not a retry of the failed source range.
    scanDailyKnowledgeMaintenance({ ...input, now: '2026-10-17T23:30:00-02:00' });
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(turns.at(-1)?.startedAt).toBe('2026-10-18T01:30:00.000Z');
    expect(input.onError).not.toHaveBeenCalled();
  });

  it('does not prepare another daily run after native admission retains a skipped Turn', () => {
    const turns: KnowledgeMaintenanceScheduleTurn[] = [];
    const prepare = vi.fn((_scope: unknown, startedAt: string) => {
      turns.push(retainedTurn(startedAt));
      return null;
    });
    const input = {
      now: instant,
      scopes: [{ ownerScope, schedule: { enabled: true } }],
      listTurns: () => turns,
      prepare,
      onError: vi.fn(),
    };
    scanDailyKnowledgeMaintenance(input);
    scanDailyKnowledgeMaintenance({ ...input });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(input.onError).not.toHaveBeenCalled();
  });
});
