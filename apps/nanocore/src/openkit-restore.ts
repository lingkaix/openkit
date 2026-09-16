#!/usr/bin/env node

import { runDataRootRestoreCli } from './storage/data-root-restore-cli.js';

const argv = process.argv.slice(2);

if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
  process.stdout.write(
    'Usage: openkit-restore --backup-root <absolute-path> --data-root <absolute-path> [--staging-root <absolute-path>]\n'
  );
} else {
  try {
    runDataRootRestoreCli(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
