export type AgentProfileId =
  | 'assistant'
  | 'task'
  | 'goal'
  | 'knowledge'
  | 'administration'
  | 'default';

export type ConversationMode = 'chat' | 'task' | 'goal' | 'unknown';

export type ThreadEntryPath = 'conversation' | 'administration' | 'knowledge-manager';

export interface AgentProfile {
  id: AgentProfileId;
  header: string;
  opening: string;
  interventions: readonly string[];
  outputs: readonly string[];
  longRun: boolean;
}

/** Declarative records. A new built-in agent adds a profile, not a screen. */
export const AGENT_PROFILES = {
  assistant: {
    id: 'assistant',
    header: 'Title',
    opening: 'Latest',
    interventions: ['Send', 'Stop'],
    outputs: ['Answer with sources', 'Handoff', 'Interactive result', 'Output'],
    longRun: false,
  },
  task: {
    id: 'task',
    header: 'Objective',
    opening: 'Anchor, then divider, then latest',
    interventions: ['Send', 'Steer', 'Stop', 'Retry', 'Redo', 'Refine', 'Review'],
    outputs: ['Output', 'File changes'],
    longRun: true,
  },
  goal: {
    id: 'goal',
    header: 'Board',
    opening: 'Board, then narrative',
    interventions: ['Edit intent', 'Approve Plan', 'Accept completion', 'Cancel'],
    outputs: ['Plan versions', 'Handoff', 'Completion candidate'],
    longRun: true,
  },
  knowledge: {
    id: 'knowledge',
    header: 'Workspace knowledge',
    opening: 'Divider or latest',
    interventions: ['Send', 'Stop', 'Decide proposals'],
    outputs: ['Knowledge changes', 'Cited answer'],
    longRun: true,
  },
  administration: {
    id: 'administration',
    header: 'Whole-server banner',
    opening: 'Latest',
    interventions: ['Send', 'Apply', 'Reject'],
    outputs: ['Configuration candidate'],
    longRun: false,
  },
  default: {
    id: 'default',
    header: 'Title and status',
    opening: 'Anchor, then divider, then latest',
    interventions: ['Send', 'Stop'],
    outputs: ['Output'],
    longRun: true,
  },
} as const satisfies Record<AgentProfileId, AgentProfile>;

export type ProfileSelection =
  | { state: 'ready'; profile: AgentProfile }
  | { state: 'error'; profileId: 'administration' | 'knowledge' };

export interface ProfileSelectionInput {
  entryPath?: ThreadEntryPath | null;
  mode?: ConversationMode | null;
  /** True when a known protected entry's thread read failed. Never selects `default`. */
  loadFailed?: boolean;
}

/**
 * `entryPath` wins for administration and knowledge-manager.
 * Conversation threads then use chat, task, or goal. Anything else is `default`.
 */
export function selectAgentProfile(input: ProfileSelectionInput): ProfileSelection {
  if (input.entryPath === 'administration' || input.entryPath === 'knowledge-manager') {
    const profileId = input.entryPath === 'administration' ? 'administration' : 'knowledge';
    if (input.loadFailed) return { state: 'error', profileId };
    return { state: 'ready', profile: AGENT_PROFILES[profileId] };
  }
  if (input.mode === 'chat') return { state: 'ready', profile: AGENT_PROFILES.assistant };
  if (input.mode === 'task') return { state: 'ready', profile: AGENT_PROFILES.task };
  if (input.mode === 'goal') return { state: 'ready', profile: AGENT_PROFILES.goal };
  return { state: 'ready', profile: AGENT_PROFILES.default };
}
