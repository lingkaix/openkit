import { ItemTypeSchema } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import { lintCopyText, lintTimelineCopy } from './copy';
import { fullContainsWork, renderVoice, resolveDisclosure } from './lens';
import { selectAgentProfile } from './profiles';
import { type EntryKind, NON_ITEM_ENTRY_KINDS, TIMELINE_REGISTRY } from './registry';

const IDENTICAL_VOICES = new Set(['human', 'decision', 'output']);

/** Kinds whose Work and Full rendering must be the same value, not merely ordered. */
function rendersIdentically(kind: EntryKind): boolean {
  const row = TIMELINE_REGISTRY[kind];
  if (IDENTICAL_VOICES.has(row.voice)) return true;
  // Run outcomes include failed, interrupted, cancelled, and unknown. Status is the error row.
  return kind === 'run-outcome' || kind === 'status';
}

/**
 * Small generator. fast-check is not a web dependency.
 * Each kind is emitted several times so the lens property is not a single happy path.
 */
function generateEntries(): { kind: EntryKind; round: number }[] {
  const kinds = Object.keys(TIMELINE_REGISTRY) as EntryKind[];
  const entries: { kind: EntryKind; round: number }[] = [];
  for (let round = 0; round < 4; round++) {
    for (const kind of kinds) entries.push({ kind, round });
  }
  return entries;
}

describe('timeline registry', () => {
  it('has a row for every protocol item type', () => {
    for (const kind of ItemTypeSchema.options) {
      expect(TIMELINE_REGISTRY[kind], kind).toBeDefined();
      expect(TIMELINE_REGISTRY[kind].copyKey).toBeTruthy();
    }
  });

  it('keeps the non-item rows, including kinds today cannot produce', () => {
    for (const kind of NON_ITEM_ENTRY_KINDS) {
      expect(TIMELINE_REGISTRY[kind]).toBeDefined();
    }
    expect(TIMELINE_REGISTRY['held-message'].produced).toBe(false);
    expect(TIMELINE_REGISTRY['digest-line'].produced).toBe(false);
    expect(TIMELINE_REGISTRY.environment.produced).toBe(false);
    expect(TIMELINE_REGISTRY['policy-attribute'].produced).toBe(false);
    expect(TIMELINE_REGISTRY['phase-marker'].produced).toBe(false);
    expect(TIMELINE_REGISTRY['thread-event'].produced).toBe(false);
  });

  it('keeps Full a superset of Work, and identical for human, decision, output, outcomes, and errors', () => {
    const entries = generateEntries();
    expect(entries.length).toBe(Object.keys(TIMELINE_REGISTRY).length * 4);
    for (const entry of entries) {
      const work = resolveDisclosure(entry.kind, 'work');
      const full = resolveDisclosure(entry.kind, 'full');
      expect(fullContainsWork(entry.kind), entry.kind).toBe(true);
      if (rendersIdentically(entry.kind)) expect(full, entry.kind).toBe(work);
    }
  });

  it('never gives the fact voice to a claim or derived row', () => {
    for (const [kind, row] of Object.entries(TIMELINE_REGISTRY)) {
      const voice = renderVoice(row.voice);
      expect(voice).toBe(row.voice);
      if (row.voice === 'claim' || row.voice === 'derived') {
        expect(voice, kind).not.toBe('fact');
      }
    }
    expect(TIMELINE_REGISTRY['assistant-message'].voice).toBe('claim');
    expect(TIMELINE_REGISTRY['assistant-message-earlier'].voice).toBe('claim');
    expect(TIMELINE_REGISTRY['runtime-activity'].voice).toBe('claim');
    expect(TIMELINE_REGISTRY['phase-marker'].voice).toBe('claim');
    expect(TIMELINE_REGISTRY['context-summary'].voice).toBe('derived');
  });
});

describe('agent profiles', () => {
  it('selects administration and knowledge-manager from entryPath before mode', () => {
    const administration = selectAgentProfile({ entryPath: 'administration', mode: 'chat' });
    const knowledge = selectAgentProfile({ entryPath: 'knowledge-manager', mode: 'task' });
    expect(administration).toMatchObject({ state: 'ready', profile: { id: 'administration' } });
    expect(knowledge).toMatchObject({ state: 'ready', profile: { id: 'knowledge' } });
  });

  it('maps conversation modes and sends unknown to default', () => {
    expect(selectAgentProfile({ entryPath: 'conversation', mode: 'chat' })).toMatchObject({
      profile: { id: 'assistant' },
    });
    expect(selectAgentProfile({ entryPath: 'conversation', mode: 'task' })).toMatchObject({
      profile: { id: 'task' },
    });
    expect(selectAgentProfile({ entryPath: 'conversation', mode: 'goal' })).toMatchObject({
      profile: { id: 'goal' },
    });
    expect(selectAgentProfile({ entryPath: 'conversation', mode: 'unknown' })).toMatchObject({
      profile: { id: 'default' },
    });
    expect(selectAgentProfile({ mode: null })).toMatchObject({ profile: { id: 'default' } });
  });

  it('shows an error for a protected entry whose load failed, never default', () => {
    const administration = selectAgentProfile({
      entryPath: 'administration',
      mode: 'chat',
      loadFailed: true,
    });
    const knowledge = selectAgentProfile({
      entryPath: 'knowledge-manager',
      loadFailed: true,
    });
    expect(administration).toEqual({ state: 'error', profileId: 'administration' });
    expect(knowledge).toEqual({ state: 'error', profileId: 'knowledge' });
    expect(administration).not.toMatchObject({ profile: { id: 'default' } });
    expect(knowledge).not.toMatchObject({ profile: { id: 'default' } });
  });
});

describe('timeline copy lint', () => {
  it('passes on the shipped strings', () => {
    expect(lintTimelineCopy()).toEqual([]);
  });

  it('fails when a banned word is planted', () => {
    const planted = 'Recorded Turn tu_019a0000-0000-7000-8000-000000000013 is an Item';
    expect(lintCopyText(planted).length).toBeGreaterThan(0);
    expect(lintTimelineCopy([planted]).some((problem) => problem.includes('banned word'))).toBe(
      true
    );
    expect(lintCopyText('Provider route and Policy revision and CapabilityCall')).not.toEqual([]);
  });
});
