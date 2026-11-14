import {
  ApplyAdministrationConfigurationRequestSchema,
  ApplyAdministrationConfigurationResponseSchema,
  PrepareAdministrationReportRequestSchema,
  PrepareAdministrationReportResponseSchema,
  SubmitAdministrationConversationRequestSchema,
  SubmitAdministrationConversationResponseSchema,
} from './administration.js';
import type { OperationDefinition } from './operation-contract.js';

/** Release-authored family facts; authority, replay and effects remain with their native owners. */
export const ADMINISTRATION_ENTRY_OPERATION_DEFINITIONS = {
  'administration.report-prepare': {
    stability: 'release-coupled',
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description:
      'Prepare local private report drafts, person-selected non-security Task proposals or operator guidance from a private source. No automatic work or upstream submission.',
    inputSchema: PrepareAdministrationReportRequestSchema,
    outputSchema: PrepareAdministrationReportResponseSchema,
    credentials: ['local-user', 'user-session'],
    scope: { kind: 'actor-quick-chat-workspace' },
    target: { kind: 'workspace' },
    policyOperation: 'turn.run',
    mutating: true,
  },
  'administration.configuration-apply': {
    stability: 'release-coupled',
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Apply one immutable human-confirmed private configuration candidate.',
    inputSchema: ApplyAdministrationConfigurationRequestSchema,
    outputSchema: ApplyAdministrationConfigurationResponseSchema,
    credentials: ['local-user', 'user-session', 'deployment-administrator'],
    scope: { kind: 'actor-quick-chat-workspace' },
    target: { kind: 'workspace' },
    policyOperation: 'turn.run',
    mutating: true,
  },
  'administration.conversation-submit': {
    stability: 'release-coupled',
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Submit a bounded private administration conversation Turn.',
    inputSchema: SubmitAdministrationConversationRequestSchema,
    outputSchema: SubmitAdministrationConversationResponseSchema,
    credentials: ['local-user', 'user-session', 'deployment-administrator'],
    scope: { kind: 'actor-quick-chat-workspace' },
    target: { kind: 'workspace' },
    policyOperation: 'turn.run',
    mutating: true,
  },
} as const satisfies Record<string, OperationDefinition>;
