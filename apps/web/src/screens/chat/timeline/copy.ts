/**
 * One copy module for user-facing timeline strings.
 * Keys are the registry's copy keys plus the chrome the current screens render.
 */

export const timelineCopy = {
  'user-message': 'Message',
  'assistant-message': 'Answer',
  'assistant-message-earlier': 'Earlier note',
  reasoning: 'Reasoning summary',
  'context-summary': 'Continuation summary',
  'knowledge-injection': 'Sources used',
  'tool-call': 'Tool step',
  'command-execution': 'Command',
  'file-change': 'File change',
  'artifact-reference': 'Output',
  'approval-request': 'Decision',
  'approval-decision': 'Recorded decision',
  'user-input-request': 'Question',
  'user-input-response': 'Recorded answer',
  'agent-handoff': 'Started a task',
  status: 'Status',
  'status-info': 'Update',
  plan: 'Plan',
  'generative-ui-reference': 'Interactive result',
  'run-trigger': 'What started this run',
  'run-outcome': 'Run outcome',
  'run-queued': 'Waiting to start',
  'runtime-activity': 'Reported by the worker',
  'phase-marker': 'Phase',
  environment: 'Environment',
  'policy-attribute': 'Policy',
  'thread-event': 'Conversation update',
  'held-message': 'Waiting for this run to end',
  'digest-line': 'What changed',
  runUnavailable: 'This run is not in this conversation.',
  selectedRun: 'Selected run',
  stopRun: 'Stop run',
  stopFailed: "Couldn't stop this run.",
  runFailed: 'This run failed. Review the conversation before trying again.',
  runStopped: 'This run was stopped. Send starts a new run.',
  candidateNotAdded:
    'The candidate was not added. Finish the existing message, then select Use in the next run again.',
  lensName: 'Work | Full',
  activityCollecting: 'Activity collection is ongoing.',
  activityPartial: 'Activity coverage is partial.',
  activityCoverageUnavailable: 'Activity coverage is unavailable.',
  captureOn: 'Full-content capture was enabled for this run.',
  captureOff: 'Full-content capture was off for this run.',
  captureUnknown: 'Full-content capture setting is unknown.',
  contextSummaryMeta: 'Covers {count} earlier messages. Exact history remains available.',
  goalReserved: 'Reserved; this Task has not started.',
  protectedEntryFailed: 'This conversation could not be loaded.',
  statusPending: 'Waiting to start',
  statusRunning: 'Running',
  statusCompleted: 'Finished',
  statusInterrupted: 'Stopped',
  statusCancelled: 'Cancelled',
  statusFailed: 'Failed',
  statusUnknown: 'Status unavailable',
  runSeparator: 'Run {index}',
  omittedActivity: '{count} earlier activity entries not shown.',
  childStarted: 'Child activity started',
  reportedProgress: 'Reported progress',
  reportedResult: 'Reported result',
  reportedFailure: 'Reported failure',
  textShortened: 'Text shortened for this timeline.',
} as const;

export type TimelineCopyKey = keyof typeof timelineCopy;

const BANNED_WORD = /\b(Turn|Item|AgentSession|Harness|AEP|CapabilityCall|Shard)\b/;
const BANNED_PHRASE = /Provider route|Policy revision/;
const IDENTIFIER =
  /\b(?:tu|th|it|itm|ws|art|usr)_[0-9a-z-]+\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

/** Problems in one user-facing string. Empty means the string passes U11. */
export function lintCopyText(text: string): string[] {
  const problems: string[] = [];
  if (BANNED_WORD.test(text) || BANNED_PHRASE.test(text)) problems.push(`banned word: ${text}`);
  if (IDENTIFIER.test(text)) problems.push(`identifier: ${text}`);
  return problems;
}

/** Lint shipped timeline copy, plus any extra strings a test plants. */
export function lintTimelineCopy(extra: readonly string[] = []): string[] {
  return [...Object.values(timelineCopy), ...extra].flatMap((text) => lintCopyText(text));
}

/** Fill a `{name}` slot. Values are numbers or already-linted labels, never raw ids. */
export function fillCopy(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key] ?? ''));
}

/** Plain label for a run status. Unknown values stay unlabeled. */
export function runStatusLabel(status: string | undefined): string {
  switch (status) {
    case 'pending':
      return timelineCopy.statusPending;
    case 'running':
      return timelineCopy.statusRunning;
    case 'completed':
      return timelineCopy.statusCompleted;
    case 'interrupted':
      return timelineCopy.statusInterrupted;
    case 'cancelled':
      return timelineCopy.statusCancelled;
    case 'failed':
      return timelineCopy.statusFailed;
    default:
      return timelineCopy.statusUnknown;
  }
}

/** Focus line for a linked run. The status is a plain word; the id stays off the line. */
export function selectedRunLabel(status: string | undefined): string {
  return `${timelineCopy.selectedRun} · ${runStatusLabel(status)}`;
}
