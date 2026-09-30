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
  return { result, value: lines.at(-1), root: lines[0]?.dataRoot as string };
}

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
