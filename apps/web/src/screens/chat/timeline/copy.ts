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
  lensWork: 'Work',
  lensFull: 'Full',
  lensWorkName: 'Work lens',
  lensFullName: 'Full lens',
  countedFromRecords: 'counted from records',
  stepsFold: '{count} steps',
  loadEarlier: 'Load earlier',
  loadLater: 'Load later',
  jumpToLatest: 'Jump to latest',
  newUpdates: '↓ {count} new',
  openAllSteps: 'Open all steps',
  restricted: 'Restricted',
  showFullText: 'Show the full text',
  failedCount: '{count} failed',
  filesChanged: '{count} files changed',
  commandsFailed: '{count} commands failed',
  earlierNotes: 'Earlier notes ({count})',
  earlierPlans: 'Earlier plans ({count})',
  inspectRun: 'Inspect',
  closeInspector: 'Close inspector',
  inspectorLabel: 'Inspector',
  usedSources: 'Used {count} sources',
  reportedByWorker: 'reported by the worker',
  runAccepted: 'Run accepted',
  runFailedTitle: 'Run failed',
  runStoppedTitle: 'Run stopped',
  runContinued: 'The run continued.',
  runEndedPlain: 'The run ended without success.',
  auditRecords: 'Audit records',
  fullSpecification: 'Full specification',
  generatedChip: 'Generated',
  someone: 'Someone',
  automationActor: 'Automation',
  actorNotRecorded: 'actor not recorded',
  identifiersHeading: 'Identifiers',
  rawOutputs: 'Raw outputs',
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
  needsYouRegion: 'Needs you',
  needsYouCount: '{count} need you',
  needsYouNext: 'Next: {title} ›',
  workIsWaiting: 'Work is waiting',
  workContinues: 'Work continues meanwhile',
  phoneNeedsMany: '{count} needs you',
  decisionSheet: 'Decision',
  stepsSheet: 'Steps',
  nextDecision: 'Next decision ({count} more) ›',
  closeSheet: 'Close',
  expandSheet: 'Expand',
  collapseSheet: 'Show less of this sheet',
  steer: 'Steer',
  steerUnavailable: "Steering isn't available yet.",
  exactEffectMissing:
    'Exact effect unavailable. Approval stays off until the full effect is shown.',
  showLess: 'Show less',
  runningCommand: 'Running a command',
  usingNamed: 'Using {name}',
  thinkingElapsed: 'Thinking · {elapsed}',
  workingElapsed: 'Working · {elapsed}',
  quietLine: 'Running {running} · no activity for {quiet}',
  workingQuiet: 'Working {running} · no activity for {quiet}',
  waitingForWorker: 'Waiting for a free worker',
  queueAhead: '{count} ahead',
  waitingForYou: 'Waiting for you · {decisions}',
  oneDecision: '1 decision',
  nDecisions: '{count} decisions',
  stopping: 'Stopping…',
  stoppedWithCause: 'Stopped {ago}: {cause}',
  stoppedAgo: 'Stopped {ago}',
  failedWithCause: 'Failed {ago}: {cause}',
  failedAgo: 'Failed {ago}',
  cancelledWithCause: 'Cancelled {ago}: {cause}',
  cancelledAgo: 'Cancelled {ago}',
  lastKnown: 'last known: {status} at {time}',
  finishedAgo: 'Finished {ago}',
  planProgress: '{done} of {total} done',
  planNow: 'now: {step}',
  updatedAgo: 'Updated {ago}',
  taskObjective: 'Objective · {objective}',
  taskStatus: 'Status · {status}',
  unknownMark: '?',
  linkedTask: 'Linked task',
  reconnecting: 'Live updates paused · reconnecting',
  offlinePaused: 'Offline. Sending is paused.',
  offlineAt: 'Offline. You are seeing what loaded at {time}. Sending is paused.',
  serverBusy: 'OpenKit is busy. Retrying in {seconds} s.',
  outOfDate: 'This page is out of date. Reload to continue.',
  sending: 'Sending',
  notSent: "Couldn't send that message. Try again.",
  sendUnknown: "We couldn't confirm OpenKit received this. Check.",
  keepDraft:
    'This Task is busy. Your message stays here. Send it when the run ends, or stop the run first.',
  approving: 'Approving…',
  waitForDecision: 'Wait for this decision to finish.',
  approveConsequence: 'Lets this call run once.',
  denyConsequence: 'The call does not run.',
  answerConsequence: 'The agent receives your answer on its next run.',
  stopConsequence:
    'Stop this run? Finished steps and their effects stay. The step in progress is cut short.',
  waitForStop: 'Wait for this run to stop.',
  staleReason: 'This is out of date, so this action is paused.',
  runEndedNeutral: 'This run ended with an error',
  systemProblem: "OpenKit couldn't finish this.",
  providerUnavailable: "OpenKit couldn't finish this: the model provider is unavailable.",
  unknownOutcome: "We can't confirm whether this finished. Check before retrying.",
  needsAccount: 'Connect the account to continue.',
  emptyTaskTitle: "This Task hasn't started yet.",
  emptyTaskHint: 'Its first run will appear here with its plan and progress.',
  emptyChatTitle: "This conversation hasn't started yet.",
  emptyChatHint: 'Messages you send will appear here, with each run and its progress.',
  hiddenCandidate: 'Candidate details are hidden until the current read succeeds.',
  dashboardRegionFailed: "Couldn't refresh this run.",
  deniedRead: "This conversation can't be shown.",
  retry: 'Retry',
  editDraft: 'Edit',
  checkSend: 'Check',
  reloadPage: 'Reload',
  statusWaiting: 'Waiting for you',
  partOfGoal: 'Part of Goal',
  goalEditConsequence:
    'This does not change running Tasks. The Coordinator reads it the next time it plans.',
  approvePlanConsequence:
    'Allows the Coordinator to start Tasks inside this plan without asking for each one.',
  acceptGoalConsequence: 'Accepts this completion. The Goal then closes, and no new Tasks start.',
  cancelGoalConsequence: 'Stops new work and asks running Tasks to stop. History stays.',
  cancelCardConsequence: "Asks this card's Task to stop. The card closes. History stays.",
  confirmCancel: 'Confirm cancel',
  keepGoal: 'Keep this Goal',
  missingTask: 'This Task is missing.',
  emptyGoalTitle: "The Coordinator's notes will appear here.",
  emptyGoalHint: 'Each run shows its plan and any handoff.',
  inspectGoal: 'Inspect goal',
  goalBoard: 'Goal board',
  awaitingDecision: 'Awaiting a decision',
  decisionRecorded: 'Decision recorded',
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
