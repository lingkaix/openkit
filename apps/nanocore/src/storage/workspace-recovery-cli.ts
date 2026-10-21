import type { WorkspaceBackupReport, WorkspaceBackupSource } from './workspace-backup.js';
import { WorkspaceRecoveryError } from './workspace-backup.js';
import type { WorkspaceMoveMemberMapping } from './workspace-move-mapping.js';

export { WorkspaceRecoveryError, type WorkspaceRecoveryErrorCode } from './workspace-backup.js';

/** Selects existing capture or admission ownership; this is not a new command journal. */
export type WorkspaceRecoverySelection =
  | { readonly kind: 'capture'; readonly backupId: string }
  | { readonly kind: 'admission'; readonly requestId: string };

/** Parsed operator input; release, feature and database-format policy is never a CLI override. */
export type WorkspaceRecoveryCliArgs =
  | {
      readonly command: 'capture';
      readonly source: WorkspaceBackupSource;
      readonly workspaceId: string;
      readonly expectedSourceDeploymentId: string;
      readonly bundleRoot: string;
      readonly backupId?: string;
      readonly purpose: 'backup' | 'move';
    }
  | { readonly command: 'verify'; readonly bundleRoot: string }
  | {
      readonly command: 'restore';
      readonly dataRoot: string;
      readonly bundleRoot: string;
      readonly workspaceId: string;
      readonly requestId: string;
      readonly acknowledgeLostSafety: boolean;
    }
  | {
      readonly command: 'move-out';
      readonly dataRoot: string;
      readonly workspaceId: string;
      readonly backupId: string;
      readonly bundleRoot: string;
      readonly expectedRevision: number;
    }
  | {
      readonly command: 'move-in';
      readonly dataRoot: string;
      readonly bundleRoot: string;
      readonly requestId: string;
      readonly targetOwnerId: string;
      readonly memberMappings: readonly WorkspaceMoveMemberMapping[];
    }
  | {
      readonly command: 'inspect' | 'finish' | 'abandon';
      readonly dataRoot: string;
      readonly workspaceId: string;
      readonly selection: WorkspaceRecoverySelection;
    }
  | {
      readonly command: 'reactivate';
      readonly dataRoot: string;
      readonly workspaceId: string;
      readonly backupId: string;
      readonly expectedRevision: number;
      /** Operator acknowledgement, not a machine proof about the remote deployment. */
      readonly acknowledgeTargetFenced: boolean;
      /** Covers every transferable copy, not only the command's local candidate. */
      readonly acknowledgeCopiesRetired: boolean;
    };

/** Path-free output; optional capture facts are absent until a complete manifest exists. */
export interface WorkspaceRecoveryCliReport {
  readonly command: WorkspaceRecoveryCliArgs['command'];
  readonly disposition:
    | 'sealed'
    | 'prepared'
    | 'verified'
    | 'restored'
    | 'moved-out'
    | 'imported'
    | 'reactivated'
    | 'abandoned'
    | 'pending'
    | 'quarantined';
  readonly workspaceId: string;
  /** Current source/target revision when the command reads or commits lifecycle authority. */
  readonly currentRevision?: number;
  readonly selection?: WorkspaceRecoverySelection;
  readonly capture?: WorkspaceBackupReport;
  readonly droppedSourceMemberIds: readonly string[];
  readonly restrictedRecovery:
    | false
    | {
        readonly backupId: string;
        readonly captureStartedAt: string;
        readonly lossDetectedAt: string;
      };
  readonly nextAction: 'none' | 'inspect' | 'finish' | 'abandon' | 'reactivate';
}

/**
 * Parses the offline Workspace command grammar without opening storage.
 * Refuses unknown, duplicate, missing, malformed, or conflicting flags.
 * @param _argv Arguments after the program name; an initial -- is permitted.
 * @returns A closed command selector; missing capture backup ID is allocated once before copy.
 * @throws WorkspaceRecoveryError; this seam currently always refuses with not-implemented.
 */
export function parseWorkspaceRecoveryArgs(_argv: readonly string[]): WorkspaceRecoveryCliArgs {
  throw new WorkspaceRecoveryError(
    'not-implemented',
    'parseWorkspaceRecoveryArgs is not implemented.'
  );
}

/**
 * Runs one offline operator command without starting NanoCore or executing packaged content.
 * Stopped-root capture and target/source decisions hold their affected root locks.
 * Backup-parent capture takes no parent lock: read-only verification brackets the copy.
 * @param _argv Arguments accepted by parseWorkspaceRecoveryArgs.
 * @param _write Sink for one path-free JSON report after a durable result or explicit inspection.
 * @returns The same operator report sent to the sink; refusals emit no success report.
 * @throws WorkspaceRecoveryError; this seam currently always refuses with not-implemented.
 */
export async function runWorkspaceRecoveryCli(
  _argv: readonly string[],
  _write: (line: string) => void = (line) => process.stdout.write(line)
): Promise<WorkspaceRecoveryCliReport> {
  throw new WorkspaceRecoveryError(
    'not-implemented',
    'runWorkspaceRecoveryCli is not implemented.'
  );
}
