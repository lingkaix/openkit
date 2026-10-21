import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allocateEntityId, isEntityId } from '@openkit/protocol';
import { readReleaseIdentity } from '../diagnostics/release-identity.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import type { WorkspaceBackupReport, WorkspaceBackupSource } from './workspace-backup.js';
import {
  createWorkspaceBackup,
  stageWorkspaceBackup,
  WORKSPACE_BACKUP_DATABASE_FORMATS,
  WorkspaceRecoveryError,
} from './workspace-backup.js';
import { parseWorkspaceBackupManifest } from './workspace-backup-bundle.js';
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

/** Refuses the closed grammar without opening any selected storage path. */
function invalid(): never {
  throw new WorkspaceRecoveryError('invalid-arguments', 'Invalid Workspace recovery arguments.');
}

/** Parses all offline verbs; a selector never supplies runtime policy or an implicit identity mapping. */
export function parseWorkspaceRecoveryArgs(argv: readonly string[]): WorkspaceRecoveryCliArgs {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  const command = args[0];
  const common = ['data-root', 'workspace-id'];
  const grammar: Record<string, readonly string[]> = {
    capture: [
      'source-data-root',
      'source-backup-root',
      'workspace-id',
      'expected-source-deployment-id',
      'bundle-root',
      'backup-id',
      'purpose',
    ],
    verify: ['bundle-root'],
    restore: [...common, 'bundle-root', 'request-id', 'acknowledge-lost-safety'],
    'move-out': [...common, 'backup-id', 'bundle-root', 'expected-revision'],
    'move-in': ['data-root', 'bundle-root', 'request-id', 'target-owner-id', 'member-map'],
    inspect: [...common, 'backup-id', 'request-id'],
    finish: [...common, 'backup-id', 'request-id'],
    abandon: [...common, 'backup-id', 'request-id'],
    reactivate: [
      ...common,
      'backup-id',
      'expected-revision',
      'acknowledge-target-fenced',
      'acknowledge-copies-retired',
    ],
  };
  if (!command || !Object.hasOwn(grammar, command)) invalid();
  const flags = new Map<string, string[]>();
  for (let i = 1; i < args.length; i++) {
    const flag = args[i]!;
    if (!flag.startsWith('--') || !grammar[command]!.includes(flag.slice(2))) invalid();
    const name = flag.slice(2);
    if (flags.has(name) && name !== 'member-map') invalid();
    const value = name.startsWith('acknowledge-') ? 'true' : args[++i];
    if (!value || value.startsWith('--') || !value.trim()) invalid();
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  const text = (name: string) => flags.get(name)?.[0] ?? invalid();
  const entity = (name: string, kind: 'ws' | 'wsbak' | 'dep' | 'usr') => {
    const value = text(name);
    if (!isEntityId(kind, value)) invalid();
    return value;
  };
  const workspace = () => entity('workspace-id', 'ws');
  const backup = () => entity('backup-id', 'wsbak');
  const request = () => {
    const value = text('request-id');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
      invalid();
    return value;
  };
  const revision = () => {
    const value = text('expected-revision');
    if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) invalid();
    return Number(value);
  };
  switch (command) {
    case 'capture': {
      if (flags.has('source-data-root') === flags.has('source-backup-root')) invalid();
      const purpose = text('purpose');
      if (purpose !== 'backup' && purpose !== 'move') invalid();
      return {
        command,
        source: flags.has('source-data-root')
          ? { kind: 'stopped-data-root', dataRoot: text('source-data-root') }
          : { kind: 'data-root-backup', backupRoot: text('source-backup-root') },
        workspaceId: workspace(),
        expectedSourceDeploymentId: entity('expected-source-deployment-id', 'dep'),
        bundleRoot: text('bundle-root'),
        ...(flags.has('backup-id') ? { backupId: backup() } : {}),
        purpose,
      };
    }
    case 'verify':
      return { command, bundleRoot: text('bundle-root') };
    case 'restore':
      return {
        command,
        dataRoot: text('data-root'),
        bundleRoot: text('bundle-root'),
        workspaceId: workspace(),
        requestId: request(),
        acknowledgeLostSafety: flags.has('acknowledge-lost-safety'),
      };
    case 'move-out':
      return {
        command,
        dataRoot: text('data-root'),
        workspaceId: workspace(),
        backupId: backup(),
        bundleRoot: text('bundle-root'),
        expectedRevision: revision(),
      };
    case 'move-in':
      return {
        command,
        dataRoot: text('data-root'),
        bundleRoot: text('bundle-root'),
        requestId: request(),
        targetOwnerId: entity('target-owner-id', 'usr'),
        memberMappings: (flags.get('member-map') ?? []).map((value) => {
          const pair = value.split('=');
          if (pair.length !== 2 || !isEntityId('usr', pair[0]) || !isEntityId('usr', pair[1]))
            invalid();
          return { sourceAccountId: pair[0]!, targetAccountId: pair[1]! };
        }),
      };
    case 'inspect':
    case 'finish':
    case 'abandon': {
      if (flags.has('backup-id') === flags.has('request-id')) invalid();
      return {
        command,
        dataRoot: text('data-root'),
        workspaceId: workspace(),
        selection: flags.has('backup-id')
          ? { kind: 'capture', backupId: backup() }
          : { kind: 'admission', requestId: request() },
      };
    }
    case 'reactivate': {
      if (!flags.has('acknowledge-target-fenced') || !flags.has('acknowledge-copies-retired'))
        invalid();
      return {
        command,
        dataRoot: text('data-root'),
        workspaceId: workspace(),
        backupId: backup(),
        expectedRevision: revision(),
        acknowledgeTargetFenced: true,
        acknowledgeCopiesRetired: true,
      };
    }
    default:
      return invalid();
  }
}

/** Uses image-owned release identity; an untagged development checkout uses its Git commit, never bundle policy. */
function installedRelease() {
  const identity = readReleaseIdentity();
  if (identity.sourceCommit)
    return { version: identity.releaseTag ?? 'source', buildId: identity.sourceCommit };
  try {
    const buildId = execFileSync(
      'git',
      ['-C', fileURLToPath(new URL('../..', import.meta.url)), 'rev-parse', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    if (!/^[0-9a-f]{40}$/.test(buildId)) throw new Error();
    return { version: 'source', buildId };
  } catch {
    throw new WorkspaceRecoveryError(
      'release-mismatch',
      'Installed release identity is unavailable.'
    );
  }
}

/** Runs capture or full, read-only verification; decision and boot verbs remain assigned to D0-2/3. */
export async function runWorkspaceRecoveryCli(
  argv: readonly string[],
  write: (line: string) => void = (line) => process.stdout.write(line)
): Promise<WorkspaceRecoveryCliReport> {
  const args = parseWorkspaceRecoveryArgs(argv);
  if (args.command !== 'capture' && args.command !== 'verify')
    throw new WorkspaceRecoveryError(
      'not-implemented',
      'This Workspace recovery decision is not implemented.'
    );
  let temporary: string | undefined;
  try {
    const parent = dirname(args.bundleRoot);
    temporary = mkdtempSync(join(parent, '.workspace-recovery-'));
    const policy = {
      bundleRoot: args.bundleRoot,
      stagingParent: temporary,
      admission: new FileStorageAdmission(parent, () => 1_000_000_000n),
      expectedRelease: installedRelease(),
      supportedDatabaseFormats: WORKSPACE_BACKUP_DATABASE_FORMATS,
    };
    let capture: WorkspaceBackupReport;
    let disposition: 'sealed' | 'prepared' | 'verified';
    if (args.command === 'capture') {
      const result = await createWorkspaceBackup({
        ...policy,
        ...args,
        backupId: args.backupId ?? allocateEntityId('wsbak'),
      });
      capture = result.report;
      disposition = result.disposition;
    } else {
      // These untrusted identity selectors grant nothing. The staged verifier binds and validates them.
      let manifest: ReturnType<typeof parseWorkspaceBackupManifest>;
      try {
        const metadata = join(args.bundleRoot, 'manifest.json');
        const stat = lstatSync(metadata);
        if (
          realpathSync(args.bundleRoot) !== resolve(args.bundleRoot) ||
          !stat.isFile() ||
          stat.nlink !== 1 ||
          stat.size > 16_777_216
        )
          throw new Error();
        manifest = parseWorkspaceBackupManifest(
          JSON.parse(readFileSync(join(args.bundleRoot, 'manifest.json'), 'utf8'))
        );
      } catch {
        throw new WorkspaceRecoveryError(
          'invalid-bundle',
          'Workspace recovery refused: invalid-bundle.'
        );
      }
      const result = await stageWorkspaceBackup({
        ...policy,
        candidateRoot: join(temporary, 'candidate'),
        expectedWorkspaceId: manifest.workspaceId,
        expectedSourceDeploymentId: manifest.sourceDeploymentId,
        purpose: manifest.purpose,
      });
      capture = result.report;
      disposition = 'verified';
    }
    const report: WorkspaceRecoveryCliReport = {
      command: args.command,
      disposition,
      workspaceId: capture.workspaceId,
      capture,
      droppedSourceMemberIds: [],
      restrictedRecovery: false,
      nextAction: disposition === 'prepared' ? 'finish' : 'none',
    };
    write(`${JSON.stringify(report)}\n`);
    return report;
  } catch (error) {
    if (error instanceof WorkspaceRecoveryError) throw error;
    throw new WorkspaceRecoveryError(
      'invalid-bundle',
      'Workspace recovery refused: invalid-bundle.'
    );
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}
