import {
  AdmitExternalTriggerRequestSchema,
  AdmitExternalTriggerResponseSchema,
} from './external-trigger.js';
import type { OperationDefinition } from './operation-contract.js';

/** A scheduled Worker may request one isolated ordinary admission for a stable source event. */
export const EXTERNAL_TRIGGER_OPERATION_DEFINITIONS = {
  'automation.event-admit': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 202,
    description: 'Admit isolated Worker work for one external event observed by a scheduled poll.',
    inputSchema: AdmitExternalTriggerRequestSchema,
    outputSchema: AdmitExternalTriggerResponseSchema,
    credentials: ['worker-package'],
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: {
      kind: 'addressed-turn',
      threadField: 'threadId',
      turnField: 'turnId',
      lineage: 'turn',
    },
    policyOperation: 'turn.run',
    mutating: true,
  },
} as const satisfies Record<string, OperationDefinition>;
