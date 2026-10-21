#!/usr/bin/env node

import { runDataRootRestoreCli } from './storage/data-root-restore-cli.js';
import { runWorkspaceRecoveryCli } from './storage/workspace-recovery-cli.js';

const argv = process.argv.slice(2);

if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
  process.stdout.write(
    'Usage: openkit-restore --backup-root <absolute-path> --data-root <absolute-path> [--staging-root <absolute-path>]\n' +
      '       openkit-restore workspace <capture|verify|restore|move-out|move-in|inspect|finish|abandon|reactivate> [options]\n'
  );
} else {
  try {
    if (argv[0] === 'workspace') await runWorkspaceRecoveryCli(argv.slice(1));
    else runDataRootRestoreCli(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
