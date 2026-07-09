import { existsSync } from 'node:fs';

import { restoreDataRootBackup } from './data-root-backup.js';
import { resolveDataRootPath } from './fs-layout.js';

/** Parsed arguments for the stopped-server data-root restore CLI. */
export interface DataRootRestoreCliArgs {
  /** Verified backup root to restore from. */
  backupRoot: string;
  /** Target NanoCore data root to replace. */
  dataRoot: string;
  /** Optional same-filesystem staging root. */
  stagingRoot?: string;
}

/** Operator-safe restore summary printed by the CLI. */
export interface DataRootRestoreCliSummary {
  /** Backup id from the verified backup manifest. */
  backupId: string;
  /** Backup capture mode from the verified manifest. */
  backupMode: 'cold' | 'hot';
  /** Backup consistency from the verified manifest. */
  consistency: 'clean' | 'crash-consistent';
  /** Inventory files verified before restore. */
  checkedFiles: string[];
  /** True after the target data root replacement completed. */
  restored: true;
}

/**
 * Parses stopped-server data-root restore CLI arguments.
 *
 * @param argv Argument vector after the script name.
 * @returns Parsed restore arguments.
 * @throws Error when required flags are missing, duplicated, or malformed.
 */
export function parseDataRootRestoreArgs(argv: readonly string[]): DataRootRestoreCliArgs {
  const flags = parseFlagValues(argv[0] === '--' ? argv.slice(1) : argv);
  const backupRoot = requireOneFlag(flags, '--backup-root');
  const dataRoot = requireOneFlag(flags, '--data-root');
  const stagingRoot = optionalOneFlag(flags, '--staging-root');

  return { backupRoot, dataRoot, ...(stagingRoot ? { stagingRoot } : {}) };
}

/**
 * Runs the stopped-server data-root restore CLI.
 *
 * @param argv Argument vector after the script name.
 * @param write Output sink for the redacted JSON summary.
 * @returns Operator-safe restore summary.
 * @throws Error when arguments are invalid, NanoCore appears active, or restore fails.
 */
export function runDataRootRestoreCli(
  argv: readonly string[],
  write: (line: string) => void = (line) => process.stdout.write(line)
): DataRootRestoreCliSummary {
  const args = parseDataRootRestoreArgs(argv);
  const lockPath = resolveDataRootPath(args.dataRoot, 'server', 'runtime', 'nanocore.lock');

  if (existsSync(lockPath)) {
    throw new Error(`Refusing to restore while NanoCore appears to be running: ${lockPath}`);
  }

  const restored = restoreDataRootBackup(args);
  const summary: DataRootRestoreCliSummary = {
    backupId: restored.manifest.id,
    backupMode: restored.manifest.backupMode,
    consistency: restored.manifest.consistency,
    checkedFiles: restored.checkedFiles,
    restored: true,
  };

  write(`${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

/**
 * Parses `--flag value` pairs into a small map.
 *
 * @param argv Argument vector.
 * @returns Map from flag name to values.
 * @throws Error when an unknown token or missing value is found.
 */
function parseFlagValues(argv: readonly string[]): Map<string, string[]> {
  const flags = new Map<string, string[]>();

  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];

    if (!flag?.startsWith('--')) {
      throw new Error(`Expected flag at argument ${index + 1}.`);
    }
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${flag}.`);
    }

    flags.set(flag, [...(flags.get(flag) ?? []), value]);
  }

  for (const flag of flags.keys()) {
    if (!['--backup-root', '--data-root', '--staging-root'].includes(flag)) {
      throw new Error(`Unknown restore flag: ${flag}`);
    }
  }

  return flags;
}

/**
 * Reads one required single-value flag.
 *
 * @param flags Parsed flag map.
 * @param flag Flag name.
 * @returns Flag value.
 * @throws Error when the flag is missing or duplicated.
 */
function requireOneFlag(flags: Map<string, string[]>, flag: string): string {
  const value = optionalOneFlag(flags, flag);

  if (!value) {
    throw new Error(`Missing required restore flag: ${flag}`);
  }

  return value;
}

/**
 * Reads one optional single-value flag.
 *
 * @param flags Parsed flag map.
 * @param flag Flag name.
 * @returns Flag value or null when absent.
 * @throws Error when the flag is duplicated.
 */
function optionalOneFlag(flags: Map<string, string[]>, flag: string): string | null {
  const values = flags.get(flag) ?? [];

  if (values.length > 1) {
    throw new Error(`Restore flag must be provided once: ${flag}`);
  }

  return values[0] ?? null;
}
