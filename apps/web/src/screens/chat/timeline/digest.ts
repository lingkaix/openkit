import type { ThreadTimelineResponse } from '@openkit/app-api-schemas';
import { fillCopy, timelineCopy } from './copy';
import { timelineJump } from './window';

/** Server digest. The client renders these lines and does not count. */
export type TimelineDigest = ThreadTimelineResponse['digest'];
export type DigestLine = TimelineDigest['lines'][number];
export type DigestAnchor = DigestLine['anchor'];

const ONE: Record<DigestLine['kind'], string> = {
  'needs-you': timelineCopy.digestNeedsYouOne,
  'runs-finished': timelineCopy.digestRunFinishedOne,
  outputs: timelineCopy.digestOutputOne,
  'plan-steps-finished': timelineCopy.digestPlanStepOne,
  problems: timelineCopy.digestProblemOne,
  'decisions-by-others': timelineCopy.digestDecisionOne,
  'new-messages': timelineCopy.digestMessageOne,
};

const MANY: Record<DigestLine['kind'], string> = {
  'needs-you': timelineCopy.digestNeedsYou,
  'runs-finished': timelineCopy.digestRunsFinished,
  outputs: timelineCopy.digestOutputs,
  'plan-steps-finished': timelineCopy.digestPlanSteps,
  problems: timelineCopy.digestProblems,
  'decisions-by-others': timelineCopy.digestDecisions,
  'new-messages': timelineCopy.digestMessages,
};

/** At most seven server lines, in server order. A missing kind is absent. */
export function visibleDigest(
  digest: { lines: readonly DigestLine[]; coverage: TimelineDigest['coverage'] } | null
): {
  lines: { kind: DigestLine['kind']; label: string; anchor: DigestAnchor }[];
  partial: string | null;
} {
  if (!digest) return { lines: [], partial: null };
  const lines = [];
  for (const line of digest.lines.slice(0, 7)) {
    const one = ONE[line.kind];
    const many = MANY[line.kind];
    if (!one || !many) continue;
    const exact = line.count === 1 ? one : fillCopy(many, { count: line.count });
    lines.push({
      kind: line.kind,
      label:
        digest.coverage === 'partial'
          ? fillCopy(timelineCopy.digestAtLeast, { line: exact })
          : exact,
      anchor: line.anchor,
    });
  }
  return {
    lines,
    partial: digest.coverage === 'partial' ? timelineCopy.digestPartial : null,
  };
}

/**
 * Opens a digest anchor with the same URL selectors as the timeline jump.
 * Item, catch-up, and latest go through `timelineJump`. Turn and attention
 * clear both canonical selectors and their aliases, then set the selector
 * `anchorFromSearch` already reads.
 */
export function digestAnchorLocation(input: {
  pathname: string;
  search: string;
  anchor: DigestAnchor;
}): { pathname: string; search: string; replace: true } {
  if (input.anchor.kind === 'item') {
    return timelineJump({
      pathname: input.pathname,
      search: input.search,
      jump: { kind: 'item', itemId: input.anchor.itemId },
    });
  }
  if (input.anchor.kind === 'latest' || input.anchor.kind === 'catch-up') {
    return timelineJump({
      pathname: input.pathname,
      search: input.search,
      jump: input.anchor,
    });
  }
  const params = new URLSearchParams(
    input.search.startsWith('?') ? input.search.slice(1) : input.search
  );
  params.delete('item');
  params.delete('attention');
  params.delete('row');
  params.delete('turnId');
  params.delete('turn');
  params.delete('catchUp');
  params.delete('request');
  if (input.anchor.kind === 'turn') params.set('turnId', input.anchor.turnId);
  if (input.anchor.kind === 'attention') params.set('attention', input.anchor.rowId);
  const search = params.toString();
  return { pathname: input.pathname, search: search ? `?${search}` : '', replace: true };
}
