/** U2: bars included, at most three emphasized elements in one viewport. */
export const EMPHASIS_LIMIT = 3;

export interface EmphasisPlan {
  bar: boolean;
  now: boolean;
  decisions: string[];
}

/**
 * The bar takes one slot when any row is waiting.
 * Waiting-for-you takes the next. Decision primary buttons take what remains.
 * Extra rows stay in the bar count and are not emphasized one by one.
 */
export function planEmphasis(input: {
  needsYou: boolean;
  nowWaiting: boolean;
  decisionIds: readonly string[];
}): EmphasisPlan {
  let left = EMPHASIS_LIMIT;
  const bar = input.needsYou && left > 0;
  if (bar) left -= 1;
  const now = input.nowWaiting && left > 0;
  if (now) left -= 1;
  const decisions: string[] = [];
  for (const id of input.decisionIds) {
    if (left <= 0) break;
    decisions.push(id);
    left -= 1;
  }
  return { bar, now, decisions };
}

export interface DecisionItem {
  id: string;
  type: string;
  approvalRequestId?: string;
  userInputRequestId?: string;
}

/** Pending decisions in read order. A recorded outcome removes the row. */
export function openDecisionIds(items: readonly DecisionItem[]): string[] {
  const decided = new Set(
    items
      .filter((item) => item.type === 'approval-decision' && item.approvalRequestId)
      .map((item) => item.approvalRequestId)
  );
  const answered = new Set(
    items
      .filter((item) => item.type === 'user-input-response' && item.userInputRequestId)
      .map((item) => item.userInputRequestId)
  );
  return items
    .filter((item) => {
      if (item.type === 'approval-request') return !decided.has(item.approvalRequestId);
      if (item.type === 'user-input-request') return !answered.has(item.userInputRequestId);
      return false;
    })
    .map((item) => item.id);
}
