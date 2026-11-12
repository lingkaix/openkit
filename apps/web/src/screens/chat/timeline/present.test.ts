import { describe, expect, it } from 'vitest';
import { lintCopyText } from './copy';
import { LONG_RUN_NOW, longRunFixture } from './fixture';
import { renderVoice } from './lens';
import { isLongRun, noteWindow, outcomeLine, stepsFoldLabel, summaryLine } from './present';
import { TIMELINE_REGISTRY } from './registry';
import { projectTimeline } from './source';

describe('long run projection', () => {
  const fixture = longRunFixture();
  const timeline = projectTimeline({
    items: fixture.items,
    turns: [fixture.turn],
    latestTurnId: fixture.turn.id,
  });
  const entry = timeline.entries[0]!;

  it('shows the latest plan and the latest 3 notes in Work, with step counts', () => {
    expect(entry.long).toBe(true);
    expect(
      isLongRun({ ...fixture.turn, stepCount: entry.stats.stepCount, now: LONG_RUN_NOW })
    ).toBe(true);
    expect(entry.plan).not.toBeNull();
    expect(entry.stats.stepCount).toBe(105);
    expect(entry.stats.fileCount).toBe(3);
    expect(entry.stats.failedCommandCount).toBe(2);
    expect(entry.stats.failedStepCount).toBe(6);
    const notes = noteWindow(
      entry.notes.map((note) => note.itemId),
      'work',
      true
    );
    expect(notes.visible).toHaveLength(3);
    expect(notes.earlierCount).toBe(2);
    expect(stepsFoldLabel(entry.stats.stepCount, entry.stats.failedStepCount)).toBe(
      '105 steps · 6 failed'
    );
    const summary = summaryLine({
      actor: 'Worker',
      running: true,
      durationMs: LONG_RUN_NOW - Date.parse(fixture.turn.startedAt ?? ''),
      stats: entry.stats,
    });
    expect(summary).toContain('running');
    expect(summary).toContain('105 steps');
    expect(summary).toContain('3 files changed');
    expect(summary).toContain('2 commands failed');
    expect(lintCopyText(summary)).toEqual([]);
  });

  it('keeps decisions and outcomes identical across lenses', () => {
    expect(outcomeLine('failed', 'tests failed')).toBe('Failed: tests failed');
    expect(outcomeLine('interrupted')).toBe('Stopped');
    expect(outcomeLine('cancelled')).toBe('Cancelled');
    expect(outcomeLine('unknown')).toBe('Status unavailable');
    expect(outcomeLine('completed')).toBeNull();
    const workNotes = noteWindow(
      entry.notes.map((note) => note.itemId),
      'work',
      true
    ).visible;
    const fullNotes = noteWindow(
      entry.notes.map((note) => note.itemId),
      'full',
      true
    ).visible;
    expect(fullNotes).toEqual(expect.arrayContaining(workNotes));
  });
});

describe('server failure counts', () => {
  it('shows a recorded count and omits a missing field', () => {
    const recorded = summaryLine({
      actor: 'Worker',
      running: false,
      durationMs: null,
      stats: { stepCount: 4, fileCount: 1, failedCommandCount: 2, failedStepCount: 3 },
    });
    expect(recorded).toContain('2 commands failed');
    expect(stepsFoldLabel(4, 3)).toBe('4 steps · 3 failed');
    const missing = summaryLine({
      actor: 'Worker',
      running: false,
      durationMs: null,
      stats: { stepCount: 4, fileCount: 1 },
    });
    expect(missing).not.toContain('commands failed');
    expect(stepsFoldLabel(4)).toBe('4 steps');
    const zero = summaryLine({
      actor: 'Worker',
      running: false,
      durationMs: null,
      stats: { stepCount: 4, fileCount: 1, failedCommandCount: 0, failedStepCount: 0 },
    });
    expect(zero).toContain('0 commands failed');
    expect(stepsFoldLabel(4, 0)).toBe('4 steps');
  });
});

describe('registry voice on an entry', () => {
  it('maps each category to itself and never gives fact to a claim', () => {
    for (const [kind, row] of Object.entries(TIMELINE_REGISTRY)) {
      expect(renderVoice(row.voice), kind).toBe(row.voice);
      if (row.voice === 'claim' || row.voice === 'derived') {
        expect(renderVoice(row.voice), kind).not.toBe('fact');
      }
    }
  });
});
