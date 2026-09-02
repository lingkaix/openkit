#!/usr/bin/env node

import { AdminRecoveryError, runOpenKitOperatorCli } from './auth/admin-recovery.js';

try {
  runOpenKitOperatorCli(process.argv.slice(2));
} catch (error) {
  const code = error instanceof AdminRecoveryError ? error.code : 'operator_failed';
  const message =
    error instanceof AdminRecoveryError ? error.message : 'The OpenKit operator command failed.';
  process.stderr.write(`${code}: ${message}\n`);
  process.exitCode = 1;
}
