import {
  DataRootBackupIdSchema,
  DeploymentIdSchema,
  entityIdPattern,
  KnowledgeBaseIdSchema,
  RequestIdSchema,
  TurnIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import type { OperationDefinition } from './operation-contract.js';

/** Existing operational backup identity; allocation remains with the capture caller. */
export const WorkspaceBackupIdSchema = z.string().regex(entityIdPattern('wsbak'));

/** Existing capture or target-admission owner, never a server filesystem selector. */
export const WorkspaceSnapshotSelectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('capture'), backupId: WorkspaceBackupIdSchema }),
  z.strictObject({ kind: z.literal('admission'), requestId: RequestIdSchema }),
]);

const text = z.string().min(1);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}(?![\s\S])/);
const localBackup = { workspaceId: WorkspaceIdSchema, backupId: WorkspaceBackupIdSchema };
const ownedRecovery = {
  workspaceId: WorkspaceIdSchema,
  selection: WorkspaceSnapshotSelectionSchema,
};

/** Path-free report projection; original operational bundle verification stays with its owner. */
export const WorkspaceSnapshotReportSchema = z.strictObject({
  command: z.enum([
    'capture',
    'verify',
    'restore',
    'move-out',
    'move-in',
    'inspect',
    'finish',
    'abandon',
    'reactivate',
  ]),
  // The existing CLI's "imported" disposition denotes operational MOVE-in, not portable import.
  disposition: z.enum([
    'sealed',
    'prepared',
    'verified',
    'restored',
    'moved-out',
    'imported',
    'reactivated',
    'abandoned',
    'pending',
    'quarantined',
  ]),
  workspaceId: WorkspaceIdSchema,
  currentRevision: count.optional(),
  selection: WorkspaceSnapshotSelectionSchema.optional(),
  capture: z
    .strictObject({
      ...localBackup,
      sourceDeploymentId: DeploymentIdSchema,
      knowledgeBaseIds: z.array(KnowledgeBaseIdSchema),
      capturedRevision: count,
      manifestDigest: digest,
      fileCount: count,
      totalBytes: count,
      coverage: z.strictObject({
        includedAuthorities: z.array(text),
        snapshotRoots: z.array(text),
        omittedProjections: z.array(text),
        omittedVolumes: z.array(text),
        externalDependencies: z.array(
          z.strictObject({
            kind: z.enum([
              'vault',
              'worker-volume',
              'native-session',
              'server-knowledge',
              'external-source',
              'agent',
              'configuration',
              'catalog',
              'repository',
              'mount',
            ]),
            reference: text,
            availability: z.enum(['available', 'unavailable', 'omitted']),
          })
        ),
      }),
      source: z
        .discriminatedUnion('kind', [
          z.strictObject({ kind: z.literal('live-workspace') }),
          z.strictObject({ kind: z.literal('stopped-data-root') }),
          z.strictObject({
            kind: z.literal('data-root-backup'),
            dataRootBackupId: DataRootBackupIdSchema,
            consistency: z.enum(['clean', 'crash-consistent']),
          }),
        ])
        .optional(),
      interruptedTurnIds: z.array(TurnIdSchema),
      unknownEffectTurnIds: z.array(TurnIdSchema),
    })
    .optional(),
  droppedSourceMemberIds: z.array(UserIdSchema),
  restrictedRecovery: z.union([
    z.literal(false),
    z.strictObject({
      backupId: WorkspaceBackupIdSchema,
      captureStartedAt: z.iso.datetime(),
      lossDetectedAt: z.iso.datetime(),
    }),
  ]),
  nextAction: z.enum(['none', 'inspect', 'finish', 'abandon', 'reactivate']),
});

const administration = {
  returnsOneTimeSecret: false,
  successStatus: 200,
  credentials: ['local-user', 'user-session', 'deployment-administrator'],
  scope: { kind: 'server' },
  target: { kind: 'deployment' },
  policyOperation: 'api.call',
} as const;

/**
 * Closed online snapshot contracts; complete capture, verify, download and restore are composed.
 * Remaining verbs stay uncomposed until their complete scoped recovery implementation.
 * Server admission supplies current administrator authority; the lifecycle owner performs try-freeze.
 */
export const WORKSPACE_SNAPSHOT_OPERATION_DEFINITIONS = {
  'workspace.backup-capture': {
    ...administration,
    binding: 'json',
    mutating: true,
    description: 'Capture one idle Workspace into an owned local operational backup.',
    inputSchema: z.strictObject({ ...localBackup, purpose: z.enum(['backup', 'move']) }),
    outputSchema: WorkspaceSnapshotReportSchema,
  },
  'workspace.backup-verify': {
    ...administration,
    binding: 'json',
    mutating: false,
    description: 'Verify one owned local operational Workspace backup.',
    inputSchema: z.strictObject(localBackup),
    outputSchema: WorkspaceSnapshotReportSchema,
  },
  'workspace.backup-download': {
    ...administration,
    binding: 'streaming',
    mutating: false,
    description:
      'Download a sealed operational backup bundle as application/octet-stream; never an analytical V3 export.',
    inputSchema: z.strictObject(localBackup),
    outputSchema: z.unknown(),
  },
  'workspace.backup-restore': {
    ...administration,
    binding: 'json',
    mutating: true,
    description:
      'Restore the original Workspace identity from a verified local backup, freezing only that target.',
    inputSchema: z.strictObject({
      ...localBackup,
      requestId: RequestIdSchema,
      acknowledgeLostSafety: z.boolean(),
    }),
    outputSchema: WorkspaceSnapshotReportSchema,
  },
  'workspace.move-out': {
    ...administration,
    binding: 'json',
    mutating: true,
    description: 'Seal one prepared operational backup and its exact moved-out Workspace revision.',
    inputSchema: z.strictObject({ ...localBackup, expectedRevision: count.min(1) }),
    outputSchema: WorkspaceSnapshotReportSchema,
  },
  'workspace.move-in': {
    ...administration,
    binding: 'streaming',
    mutating: true,
    binaryRequestBody: {
      mediaType: 'application/octet-stream',
      description:
        'The complete sealed operational Workspace backup bundle, verified before target freeze; not an analytical archive.',
    },
    description: 'Verify and admit one streamed MOVE bundle with an injective account map.',
    inputSchema: z.strictObject({
      workspaceId: WorkspaceIdSchema,
      requestId: RequestIdSchema,
      targetOwnerId: UserIdSchema.optional(),
      memberMappings: z.array(
        z.strictObject({ sourceAccountId: UserIdSchema, targetAccountId: UserIdSchema })
      ),
    }),
    outputSchema: WorkspaceSnapshotReportSchema,
  },
  'workspace.recovery-inspect': {
    ...administration,
    binding: 'json',
    mutating: false,
    description: 'Inspect an exact operational capture or target-admission owner.',
    inputSchema: z.strictObject(ownedRecovery),
    outputSchema: WorkspaceSnapshotReportSchema,
  },
  'workspace.recovery-finish': {
    ...administration,
    binding: 'json',
    mutating: true,
    description:
      'Explicitly finish the selected owned recovery under current proofs and authority.',
    inputSchema: z.strictObject(ownedRecovery),
    outputSchema: WorkspaceSnapshotReportSchema,
  },
  'workspace.recovery-abandon': {
    ...administration,
    binding: 'json',
    mutating: true,
    description:
      'Close the selected recovery publication right before retiring its owned candidate.',
    inputSchema: z.strictObject(ownedRecovery),
    outputSchema: WorkspaceSnapshotReportSchema,
  },
  'workspace.move-reactivate': {
    ...administration,
    binding: 'json',
    mutating: true,
    description:
      'Reactivate the exact moved-out revision after explicit target-fencing and copy-retirement acknowledgement.',
    inputSchema: z.strictObject({
      ...localBackup,
      expectedRevision: count.min(1),
      acknowledgeTargetFenced: z.boolean(),
      acknowledgeCopiesRetired: z.boolean(),
    }),
    outputSchema: WorkspaceSnapshotReportSchema,
  },
} as const satisfies Record<string, OperationDefinition>;

/** Path-free capture and recovery observations; no physical cleanup or external-effect inference. */
export type WorkspaceSnapshotReport = z.infer<typeof WorkspaceSnapshotReportSchema>;
/** Existing operational owner selected for inspect, finish or abandon. */
export type WorkspaceSnapshotSelection = z.infer<typeof WorkspaceSnapshotSelectionSchema>;
