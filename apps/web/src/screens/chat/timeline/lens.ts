import type { EntryKind } from './registry';
import { registryRow } from './registry';
import type { Disclosure, LensName, RenderDecision, VoiceCategory } from './types';

/**
 * Least revealed to most revealed.
 * Full contains Work when its rank is greater than or equal.
 */
const DISCLOSURE_RANK: Record<Disclosure, number> = {
  hidden: 0,
  inspector: 1,
  conditional: 2,
  counted: 3,
  folded: 4,
  marker: 5,
  grouped: 6,
  badge: 7,
  row: 8,
  card: 9,
  shown: 10,
};

/** Disclosure column for one lens. Work and Full read the row; they do not branch further. */
export function resolveDisclosure(kind: EntryKind, lens: LensName): Disclosure {
  const row = registryRow(kind);
  return lens === 'work' ? row.work : row.full;
}

export function disclosureRank(disclosure: Disclosure): number {
  return DISCLOSURE_RANK[disclosure];
}

/** Full's rendering contains Work's. Equal disclosure counts as contained. */
export function fullContainsWork(kind: EntryKind): boolean {
  return (
    disclosureRank(resolveDisclosure(kind, 'full')) >=
    disclosureRank(resolveDisclosure(kind, 'work'))
  );
}

/**
 * Map a registry category to the voice a row may render with.
 * Claim and derived stay themselves, so they cannot take the fact voice.
 */
export function renderVoice(category: VoiceCategory): VoiceCategory {
  switch (category) {
    case 'claim':
      return 'claim';
    case 'derived':
      return 'derived';
    case 'human':
      return 'human';
    case 'fact':
      return 'fact';
    case 'decision':
      return 'decision';
    case 'output':
      return 'output';
    case 'process':
      return 'process';
  }
}

/** Registry row × lens → what a component is allowed to render. */
export function resolveRender(kind: EntryKind, lens: LensName): RenderDecision {
  const row = registryRow(kind);
  return {
    voice: renderVoice(row.voice),
    disclosure: resolveDisclosure(kind, lens),
    compression: row.compression,
    attention: row.attention,
    links: row.links,
    copyKey: row.copyKey,
  };
}
