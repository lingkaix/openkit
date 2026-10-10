import {
  AppUpdateStatusResponseReaderSchema,
  PrepareAppUpdateRequestSchema,
  PrepareAppUpdateResponseReaderSchema,
  StartAppUpdateRequestSchema,
} from './app-update.js';
import type { OperationDefinition } from './operation-contract.js';

/** Release-authored family facts; authority, replay and effects remain with their native owners. */
export const APP_UPDATE_OPERATION_DEFINITIONS = {
  'app-update.prepare': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Prepare one published App release and current-image binding.',
    inputSchema: PrepareAppUpdateRequestSchema,
    outputSchema: PrepareAppUpdateResponseReaderSchema,
    credentials: ['local-user', 'user-session', 'deployment-administrator'],
    scope: { kind: 'server' },
    target: { kind: 'deployment' },
    policyOperation: 'api.call',
    mutating: true,
  },
  'app-update.start': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Start one prepared App update with explicit maintenance consent.',
    inputSchema: StartAppUpdateRequestSchema,
    outputSchema: AppUpdateStatusResponseReaderSchema,
    credentials: ['local-user', 'user-session', 'deployment-administrator'],
    scope: { kind: 'server' },
    target: { kind: 'deployment' },
    policyOperation: 'api.call',
    mutating: true,
  },
  'app-update.status': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    description: 'Read one host-owned App update receipt.',
    inputSchema: StartAppUpdateRequestSchema.pick({ requestId: true }),
    outputSchema: AppUpdateStatusResponseReaderSchema,
    credentials: ['local-user', 'user-session', 'deployment-administrator'],
    scope: { kind: 'server' },
    target: { kind: 'deployment' },
    policyOperation: 'api.call',
    mutating: false,
  },
} as const satisfies Record<string, OperationDefinition>;
