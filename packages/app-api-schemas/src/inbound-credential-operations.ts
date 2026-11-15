import { z } from 'zod';
import {
  ListInboundCredentialsResponseSchema,
  RevokeInboundCredentialRequestSchema,
  RevokeInboundCredentialResponseSchema,
} from './inbound-credentials.js';
import type { OperationDefinition } from './operation-contract.js';

/** One material-free management surface over the original inbound credential owners. */
export const INBOUND_CREDENTIAL_OPERATION_DEFINITIONS = {
  'credential.list': {
    stability: 'release-coupled',
    description: 'List owned inbound credentials and administrator-visible transport credentials.',
    inputSchema: z.object({}).strict(),
    outputSchema: ListInboundCredentialsResponseSchema,
    credentials: ['local-user', 'user-session', 'deployment-administrator'],
    scope: { kind: 'user' },
    target: { kind: 'user' },
    policyOperation: 'api.call',
    mutating: false,
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
  },
  'credential.revoke': {
    stability: 'release-coupled',
    description: 'Revoke an owned inbound credential or end its original Worker run.',
    inputSchema: RevokeInboundCredentialRequestSchema,
    outputSchema: RevokeInboundCredentialResponseSchema,
    credentials: ['local-user', 'user-session', 'deployment-administrator'],
    scope: { kind: 'user' },
    target: { kind: 'user' },
    policyOperation: 'api.call',
    mutating: true,
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
  },
} as const satisfies Record<string, OperationDefinition>;
