import type { TimelineCopyKey } from './copy';

/** U1 voice category. Claim and derived are never the fact voice. */
export type VoiceCategory =
  | 'human'
  | 'claim'
  | 'fact'
  | 'decision'
  | 'output'
  | 'process'
  | 'derived';

/**
 * How much of a row a lens shows.
 * Ranked in `lens.ts`: a higher rank reveals everything a lower rank reveals.
 */
export type Disclosure =
  | 'hidden'
  | 'inspector'
  | 'conditional'
  | 'counted'
  | 'folded'
  | 'marker'
  | 'grouped'
  | 'badge'
  | 'row'
  | 'card'
  | 'shown';

export type CompressionRule = 'none' | 'R2' | 'R2-R4' | 'R5' | 'R6' | 'R7' | 'R8' | 'never';

/** Closed attention predicates. "interrupt if blocking" is one predicate, not open logic. */
export type AttentionClass = 'none' | 'ambient' | 'interrupt' | 'interrupt-if-blocking';

export type LinkKind =
  | 'none'
  | 'inspector'
  | 'knowledge'
  | 'audit-call'
  | 'connection'
  | 'gateway'
  | 'full-body'
  | 'output-version'
  | 'attention'
  | 'exact-effect'
  | 'task'
  | 'fix'
  | 'knowledge-diff'
  | 'source'
  | 'audit-run';

export interface RegistryRow {
  voice: VoiceCategory;
  work: Disclosure;
  full: Disclosure;
  compression: CompressionRule;
  attention: AttentionClass;
  links: readonly LinkKind[];
  copyKey: TimelineCopyKey;
  /** False when today's dashboard and item reads cannot produce this kind. */
  produced: boolean;
}

export type LensName = 'work' | 'full';

export interface RenderDecision {
  voice: VoiceCategory;
  disclosure: Disclosure;
  compression: CompressionRule;
  attention: AttentionClass;
  links: readonly LinkKind[];
  copyKey: TimelineCopyKey;
}
