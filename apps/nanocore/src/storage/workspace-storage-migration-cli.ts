import { parseArgs } from 'node:util';

import {
  migrateWorkspaceStorage,
  type WorkspaceStorageMigrationResult,
} from './workspace-storage-migration.js';

/** Parsed arguments for the stopped-process Workspace storage migration CLI. */
export interface WorkspaceStorageMigrationCliArgs {
  /** External destination for the complete predecessor cold backup. */
  readonly backupRoot: string;
  /** Predecessor v1 data root to migrate. */
  readonly dataRoot: string;
}

/** Operator-safe summary printed after a successful Workspace storage migration. */
export type WorkspaceStorageMigrationCliSummary = WorkspaceStorageMigrationResult;

/**
 * Parses stopped-process Workspace storage migration arguments.
 *
 * @param argv Argument vector after the script name.
 * @returns Required data-root and backup-root arguments.
 * @throws Error when a flag is missing, duplicated, unknown, or malformed.
 */
export function parseWorkspaceStorageMigrationArgs(
  argv: readonly string[]
): WorkspaceStorageMigrationCliArgs {
  const { values } = parseArgs({
    allowPositionals: false,
    args: argv[0] === '--' ? [...argv.slice(1)] : [...argv],
    options: {
      'backup-root': { multiple: true, type: 'string' },
      'data-root': { multiple: true, type: 'string' },
    },
    strict: true,
  });
  return {
    backupRoot: requireOneFlag(values['backup-root'], '--backup-root'),
    dataRoot: requireOneFlag(values['data-root'], '--data-root'),
  };
}

/**
 * Runs the thin stopped-process Workspace storage migration CLI.
 *
 * @param argv Argument vector after the script name.
 * @param write Output sink for the path-free JSON summary.
 * @returns Operator-safe success summary.
 * @throws Error when arguments, preflight, backup, migration, or verification fail.
 */
export function runWorkspaceStorageMigrationCli(
  argv: readonly string[],
  write: (line: string) => void = (line) => process.stdout.write(line)
): WorkspaceStorageMigrationCliSummary {
  const args = parseWorkspaceStorageMigrationArgs(argv);
  const summary = migrateWorkspaceStorage(args);

  write(`${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

/**
 * Reads one required single-value flag.
 *
 * @param values Parsed values for one flag.
 * @param flag Required flag name.
 * @returns Flag value.
 * @throws Error when the flag is missing or duplicated.
 */
function requireOneFlag(values: string[] | undefined, flag: string): string {
  const candidates = values ?? [];

  if (candidates.length === 0) {
    throw new Error(`Missing required Workspace storage migration flag: ${flag}`);
  }
  if (candidates.length > 1) {
    throw new Error(`Workspace storage migration flag must be provided once: ${flag}`);
  }

  return candidates[0]!;
}
