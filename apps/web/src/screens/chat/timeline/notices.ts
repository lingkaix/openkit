import { lintCopyText } from './copy';

/**
 * User-facing sentences for references, back-links and toasts.
 * They live beside the timeline copy module because that file is shared with the divider slice.
 * U11 still lints every string.
 */
export const timelineNotices = {
  sourceNotAvailable: 'Source not available to you',
  versionUnavailable: 'Version {version} unavailable',
  openVersionList: "Open the output's version list",
  backLink: 'From: {title} · run at {time}',
  backLinkNoTime: 'From: {title}',
  runAt: 'run at {time}',
  mergedDecisions: '{count} decisions need you in {thread}',
  moreToasts: '+{count} more · Open Action Center',
  opensRunNotMessage: 'Opens the run (not the exact message)',
  opensRunNotRequest: 'Opens the run (not the request)',
  opensKnowledge: 'Opens Knowledge (not the page)',
  opensWorkspaceChanges: 'Opens Workspace changes (not the row)',
  inspectorOnly: 'Shown in the inspector',
  connectionUnavailable: 'No connection anchor is recorded',
  noDestination: 'No destination is recorded for this row',
  untitledConversation: 'Untitled conversation',
  view: 'View',
} as const;

/** Problems in the reference sentences. Empty means they pass U11. */
export function lintTimelineNotices(): string[] {
  return Object.values(timelineNotices).flatMap((text) => lintCopyText(text));
}
