import { z } from 'zod';
import {
  DataRootBackupCreateResponseSchema,
  DataRootBackupVerifyRequestSchema,
  DataRootBackupVerifyResponseSchema,
  StorageLayoutReportResponseSchema,
} from './storage.js';

/** Release-authored data root admin contracts; execution and current administrator authority stay in NanoCore. */
export const DATA_ROOT_ADMIN_OPERATION_DEFINITIONS = {
  'backup.create': {
    description:
      'Create a hot data-root backup with server-managed local handles and declared coverage.',
    inputSchema: z.object({}).strict(),
    outputSchema: DataRootBackupCreateResponseSchema,
    credentials: ['local-user', 'user-session', 'deployment-administrator'],
    scope: { kind: 'server' },
    target: { kind: 'deployment' },
    policyOperation: 'api.call',
    mutating: true,
  },
  'backup.verify': {
    description: 'Verify a server-managed data-root backup and its exact inventory.',
    inputSchema: DataRootBackupVerifyRequestSchema.strict(),
    outputSchema: DataRootBackupVerifyResponseSchema,
    credentials: ['local-user', 'user-session', 'deployment-administrator'],
    scope: { kind: 'server' },
    target: { kind: 'deployment' },
    policyOperation: 'api.call',
    mutating: false,
  },
  'storage.layout-report': {
    description: 'Read the deployment storage layout report.',
    inputSchema: z.object({}).strict(),
    outputSchema: StorageLayoutReportResponseSchema,
    credentials: ['local-user', 'user-session', 'deployment-administrator'],
    scope: { kind: 'server' },
    target: { kind: 'deployment' },
    policyOperation: 'api.call',
    mutating: false,
  },
} as const;
