import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';

it('extends the existing journal kind CHECK while preserving original bytes, links and settlement guards', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    db.exec(
      readFileSync(
        new URL('../../drizzle/workspace/0012_execution_journal.sql', import.meta.url),
        'utf8'
      )
    );
    const span = {
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      startTimeUnixNano: '1',
      endTimeUnixNano: null,
    };
    db.prepare('INSERT INTO control_executions VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
      'execution',
      1,
      JSON.stringify({ kind: 'workspace', workspaceId: 'ws-original' }),
      'work',
      'workspace-worker-turn/v1',
      'original-hash',
      'open',
      1,
      null,
      '[]',
      JSON.stringify(span)
    );
    const insert = db.prepare(
      'INSERT INTO control_execution_steps VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'
    );
    const row = (
      id: string,
      ordinal: number,
      kind: string,
      parent: string | null,
      state = 'intent'
    ) => [
      'execution',
      id,
      1,
      ordinal,
      parent,
      state,
      `invocation-${id}`,
      JSON.stringify({
        definitionVersion: 'workspace-worker-turn/v1',
        kind,
        workId: 'work',
        invocationId: `invocation-${id}`,
        actor: { kind: 'user', id: 'original' },
        inputRefs: [],
        outputRefs: [],
        authorityRefs: [],
        physicalFenceRefs: [],
        retryPermitted: false,
        deadlineUnixNano: null,
        target: null,
        futureDescription: 'Original é bytes',
      }),
      JSON.stringify({
        parent: parent ? { executionId: 'execution', stepId: parent } : null,
        carriage: { operation: 'original' },
        clock: {
          processWitness: 'original-process',
          admittedUnixNano: '1',
          admittedMonotonicNano: '2',
        },
      }),
      JSON.stringify({
        ...span,
        spanId: ordinal.toString(16).padStart(16, '0'),
        endTimeUnixNano: state === 'intent' ? null : '3',
        status: { code: state === 'unknown' ? 'ERROR' : 'UNSET' },
      }),
      parent ? 'execution' : null,
      parent,
    ];
    insert.run(...row('parent', 1, 'materialize', null));
    for (const [index, state] of ['completed', 'failed', 'unknown', 'cancelled'].entries())
      insert.run(...row(state, index + 2, 'inspect-session', 'parent', state));
    expect(() => insert.run(...row('steer', 6, 'deliver-steer', 'parent'))).toThrow(/CHECK/);
    const before = db.prepare('SELECT * FROM control_execution_steps ORDER BY ordinal').all();
    db.transaction(() =>
      db.exec(
        readFileSync(
          new URL('../../drizzle/workspace/0023_task_steer.sql', import.meta.url),
          'utf8'
        )
      )
    )();
    expect(db.prepare('SELECT * FROM control_execution_steps ORDER BY ordinal').all()).toEqual(
      before
    );
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(() =>
      db
        .prepare('INSERT INTO control_execution_steps VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(...row('steer', 6, 'deliver-steer', 'parent'))
    ).not.toThrow();
    expect(() =>
      db
        .prepare(
          "UPDATE control_execution_steps SET control_json=json_set(control_json,'$.inputRefs',json_array('changed')) WHERE step_id='completed'"
        )
        .run()
    ).toThrow(/immutable/);
    expect(() =>
      db
        .prepare('INSERT INTO control_execution_steps VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(...row('bad-parent', 7, 'deliver-steer', 'absent'))
    ).toThrow(/parent|FOREIGN/);
    db.prepare('INSERT INTO control_execution_steps VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(
      ...row('future-parent', 10, 'materialize', null)
    );
    expect(() =>
      db
        .prepare('INSERT INTO control_execution_steps VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(...row('wrong-order', 8, 'deliver-steer', 'future-parent'))
    ).toThrow(/prior/);
    expect(() =>
      db
        .prepare('INSERT INTO control_execution_steps VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(...row('unknown-kind', 7, 'invented-kind', 'parent'))
    ).toThrow(/CHECK/);
  } finally {
    db.close();
  }
});
