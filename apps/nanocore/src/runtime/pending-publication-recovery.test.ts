import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/** Runs the reviewer's public-command fault boundary in a real separate process. */
function probe(mode: string, phase = 'first', root?: string) {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'src/test-support/pending-publication-crash.ts',
      mode,
      phase,
      ...(root ? [root] : []),
    ],
    { encoding: 'utf8', timeout: 60_000 }
  );
  const lines = result.stdout
    .trim()
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));
  return { result, value: lines.at(-1), initial: lines[0], root: lines[0]?.dataRoot as string };
}

describe('public command publication commit', () => {
  it('leaves no product without its receipt after process loss at the receipt write', () => {
    const crashed = probe('command-commit', 'before-receipt');
    expect(crashed.result.status, crashed.result.stderr).toBe(23);
    expect(crashed.value.checkpoint).toBe('before-receipt');
    const cold = probe('command-commit', 'inspect', crashed.root);
    expect(cold.result.status, cold.result.stderr).toBe(0);
    expect(cold.value.state).toEqual(crashed.initial.before);
  }, 90_000);

  it('does not publish product caches or durable product state after a receipt write failure', () => {
    const failed = probe('command-commit', 'receipt-failure');
    expect(failed.result.status, failed.result.stderr).toBe(0);
    expect(failed.value.checkpoint).toBe(true);
    expect(failed.value.commandFailed).toBe(true);
    expect(failed.value.live).toEqual(failed.initial.before);
    expect(failed.value.cold).toEqual(failed.initial.before);
  }, 90_000);

  it('resolves a lost committed response by exact replay and rejects changed input without another product', () => {
    const crashed = probe('command-commit', 'after-commit');
    expect(crashed.result.status, crashed.result.stderr).toBe(23);
    expect(crashed.value.checkpoint).toBe('response-ready');
    expect(crashed.value.responseStatus).toBe(200);
    const cold = probe('command-commit', 'inspect', crashed.root);
    expect(cold.result.status, cold.result.stderr).toBe(0);
    expect(cold.value.state.threads).toHaveLength(crashed.initial.before.threads.length + 1);
    expect(cold.value.state.receipts).toEqual([
      expect.objectContaining({
        response_kind: 'thread',
        response_id: crashed.value.responseBody.id,
      }),
    ]);
    const replay = probe('command-commit', 'replay', crashed.root);
    expect(replay.result.status, replay.result.stderr).toBe(0);
    expect(replay.value.responseStatus).toBe(200);
    expect(replay.value.responseBody).toEqual(crashed.value.responseBody);
    expect(replay.value.cold).toEqual(cold.value.state);
    const conflict = probe('command-commit', 'conflict', crashed.root);
    expect(conflict.result.status, conflict.result.stderr).toBe(0);
    expect(conflict.value.responseStatus).toBe(409);
    expect(conflict.value.cold).toEqual(cold.value.state);
  }, 90_000);
});

describe('local Pending Request commit', () => {
  it('leaves no decision, publication, Item, event or receipt after process loss before the command receipt', () => {
    const crashed = probe('local-outcome', 'before-receipt');
    expect(crashed.result.status, crashed.result.stderr).toBe(23);
    expect(crashed.value.checkpoint).toBe('before-receipt');
    const cold = probe('local-outcome', 'inspect', crashed.root);
    expect(cold.result.status, cold.result.stderr).toBe(0);
    expect(cold.value.state).toEqual(crashed.initial.before);
  }, 90_000);

  it('keeps failed outcome candidates out of live reads, cold reads and existing listeners', () => {
    const failed = probe('local-outcome', 'receipt-failure');
    expect(failed.result.status, failed.result.stderr).toBe(0);
    expect(failed.value.checkpoint).toBe(true);
    expect(failed.value.responseStatus).toBeGreaterThanOrEqual(400);
    expect.soft(failed.value.notifications).toEqual([]);
    expect.soft(failed.value.live).toEqual(failed.initial.before);
    expect.soft(failed.value.cold).toEqual(failed.initial.before);
  }, 90_000);

  it('reopens the whole committed outcome and resolves a lost response without another Turn or Item', () => {
    const crashed = probe('local-outcome', 'after-commit');
    expect(crashed.result.status, crashed.result.stderr).toBe(23);
    expect(crashed.value.checkpoint).toBe('response-ready');
    expect(crashed.value.responseStatus).toBe(200);
    const cold = probe('local-outcome', 'inspect', crashed.root);
    expect(cold.result.status, cold.result.stderr).toBe(0);
    const state = cold.value.state;
    expect(state.requests[0]).toMatchObject({ resolution: 'granted', delivery: 'delivered' });
    expect(state.turns).toHaveLength(crashed.initial.before.turns.length + 1);
    expect(state.turns).toContainEqual(
      expect.objectContaining({ id: state.requests[0].publicationTurnId, status: 'completed' })
    );
    expect(state.items).toHaveLength(crashed.initial.before.items.length + 1);
    expect(
      state.items.filter(
        (item: { causationId?: string }) => item.causationId === state.requests[0].requestItemId
      )
    ).toEqual([
      expect.objectContaining({
        type: 'approval-decision',
        turnId: state.requests[0].publicationTurnId,
      }),
    ]);
    expect(
      state.receipts.filter(
        (receipt: { command_name: string }) => receipt.command_name === 'approval.respond'
      )
    ).toEqual([expect.objectContaining({ response_kind: 'approval', response_id: 'ap_crash_0' })]);
    const replay = probe('local-outcome', 'replay', crashed.root);
    expect(replay.result.status, replay.result.stderr).toBe(0);
    expect(replay.value.responseStatus).toBe(200);
    expect(replay.value.responseBody).toEqual(crashed.value.responseBody);
    expect(replay.value.cold).toEqual(state);
    const conflict = probe('local-outcome', 'conflict', crashed.root);
    expect(conflict.result.status, conflict.result.stderr).toBe(0);
    expect(conflict.value.responseStatus).toBe(409);
    expect(conflict.value.cold).toEqual(state);
  }, 90_000);
});

describe('public pending publication recovery', () => {
  it.each([
    'delivery',
    'closeout',
    'invalidation',
  ])('completes a named %s after a real process exit before its first Item', (mode) => {
    const crashed = probe(mode);
    expect(crashed.result.status, crashed.result.stderr).toBe(23);
    const recovered = probe(mode, 'first', crashed.root);
    expect(recovered.result.status, recovered.result.stderr).toBe(0);
    const published = recovered.value.records.filter(
      (record: { publicationTurnId: string | null }) => record.publicationTurnId !== null
    );
    expect(published.length).toBeGreaterThan(0);
    for (const record of published) {
      expect(record.status).toBe('completed');
      expect(record.validation).toBeNull();
      expect(record.items.length).toBeGreaterThan(0);
      if (mode === 'invalidation')
        expect(record.invalidationTurnId).not.toBe(record.publicationTurnId);
      expect(record.delivery).toBe(mode === 'closeout' ? 'closed-out' : 'delivered');
    }
    const repeated = probe(mode, 'first', crashed.root);
    expect(repeated.value.records).toEqual(recovered.value.records);
  }, 90_000);

  it.each([
    'delivery',
    'closeout',
    'invalidation',
  ])('completes a named %s after a real process exit between Items', (mode) => {
    const crashed = probe(mode, 'between');
    expect(crashed.result.status, crashed.result.stderr).toBe(23);
    const recovered = probe(mode, 'between', crashed.root);
    expect(recovered.result.status, recovered.result.stderr).toBe(0);
    for (const record of recovered.value.records) {
      expect(record.status).toBe('completed');
      expect(record.validation).toBeNull();
      expect(record.delivery).toBe(mode === 'closeout' ? 'closed-out' : 'delivered');
      expect(record.items).toEqual(
        mode === 'closeout'
          ? ['status']
          : mode === 'invalidation'
            ? ['approval-decision', 'status']
            : ['approval-decision']
      );
    }
  }, 90_000);

  it('does not report successful delivery when the first Item write throws', () => {
    const failed = probe('throw');
    expect(failed.result.status, failed.result.stderr).toBe(0);
    expect(JSON.parse(failed.result.stdout.trim().split('\n')[0]!).responseStatus).not.toBe(200);
    expect(failed.value.records[0]).toMatchObject({
      delivery: 'frozen',
      status: 'running',
      items: [],
    });
    const recovered = probe('throw', 'first', failed.root);
    expect(recovered.value.records[0]).toMatchObject({
      delivery: 'delivered',
      status: 'completed',
      items: ['approval-decision'],
      validation: null,
    });
  }, 90_000);

  it.each([
    'delivery',
    'closeout',
  ])('keeps independent %s identity through named completion and reopen', (mode) => {
    const crashed = probe(mode);
    expect(crashed.result.status, crashed.result.stderr).toBe(23);
    const recovered = probe(mode, 'first', crashed.root);
    expect(recovered.result.status, recovered.result.stderr).toBe(0);
    const identities = recovered.value.records.flatMap(
      (record: { publicationTurnId: string | null }) =>
        record.publicationTurnId ? [record.publicationTurnId] : []
    );
    expect(identities.length).toBeGreaterThan(0);
    for (const id of identities)
      expect(id).toMatch(
        /^tu_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
    const repeated = probe(mode, 'first', crashed.root);
    expect(repeated.value.records).toEqual(recovered.value.records);
  }, 90_000);

  it.each([
    'delivery',
    'closeout',
  ])('refuses a %s Turn persisted before its association without a replacement', (mode) => {
    const crashed = probe(mode, 'before-association');
    expect(crashed.result.status, crashed.result.stderr).toBe(23);
    const refused = probe(mode, 'before-association', crashed.root);
    expect(refused.result.status, refused.result.stderr).toBe(0);
    expect(refused.value.recoveryCode).toBe('recovery_required');
    expect(refused.value.before).toEqual(refused.value.after);
    const repeated = probe(mode, 'before-association', crashed.root);
    expect(repeated.value).toEqual(refused.value);
  }, 90_000);

  it('refuses a recorded closeout pointer whose canonical Turn is missing', () => {
    const crashed = probe('closeout');
    expect(crashed.result.status, crashed.result.stderr).toBe(23);
    const refused = probe('closeout', 'missing-turn', crashed.root);
    expect(refused.result.status, refused.result.stderr).toBe(0);
    expect(refused.value.recoveryCode).toBe('recovery_required');
    expect(refused.value.before).toEqual(refused.value.after);
  }, 90_000);

  it('reloads one shared archive decision and invalidation publication as canonical', () => {
    const archived = probe('shared-closeout');
    expect(archived.result.status, archived.result.stderr).toBe(0);
    for (const record of archived.value.records) {
      expect(record.publicationTurnId).toBe(record.invalidationTurnId);
      expect(record).toMatchObject({
        delivery: 'closed-out',
        status: 'completed',
        resolution: 'granted',
        validation: null,
      });
      expect(record.items).toEqual(['approval-decision', 'status']);
    }
    expect(probe('shared-closeout', 'first', archived.root).value.records).toEqual(
      archived.value.records
    );
  }, 90_000);
});
