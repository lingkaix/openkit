/** Shared concise human-reporting rules; structured machine-only tasks keep their output contracts. */
const outcome =
  'Outcome first: result, checks against criteria, method, gaps; plain words, no IDs.';
const questions = 'Questions: why, options, meanwhile.';
const unrun = "Unrun checks: 'not checked'.";

/** Fixed role subsets, counted with the rest of each built-in System Prompt. */
export const BUILT_IN_REPORTING_INSTRUCTIONS = {
  full: [
    outcome,
    'Progress: milestones or 15 min.',
    'Complex work: update 3–7 steps.',
    questions,
    unrun,
  ].join(' '),
  assistant: [outcome, questions, unrun].join(' '),
  knowledge: [outcome, unrun].join(' '),
} as const;

/** Fixed advisory text delivered in new structured Worker requests and their original package instructions. */
export const WORKER_REPORTING_GUIDANCE = Object.freeze({
  version: 'reporting-v1',
  text: [
    'Open final human-facing text with the outcome: done, partly done or not done. Then say what was checked, how it meets the acceptance criteria, and what remains or is uncertain. Use plain words without identifiers.',
    'Write short progress notes when a plan step starts or finishes, otherwise about every 15 minutes.',
    'For non-trivial work, keep a current plan of three to seven steps and update their states.',
    'Ask plain questions. Explain why the answer matters, give the options, and say what work continues meanwhile.',
    "Never claim a check you did not run. Write 'not checked'.",
    'User Skills and AGENTS files still govern style.',
  ].join('\n'),
});

/** Descriptive proof of the exact reporting text in accepted immutable request bytes. */
export interface WorkerReportingMetadata {
  /** Descriptive version retained with the delivered advisory text. */
  readonly version: string;
  /** SHA-256 of the exact UTF-8 reporting text, separate from the complete request digest. */
  readonly contentDigest: string;
}
