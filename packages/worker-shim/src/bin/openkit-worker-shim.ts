#!/usr/bin/env node
import { runWorkerHarness } from '../harness.js';

const argv = process.argv.slice(2);
if (argv.length !== 0) {
  console.error('Worker Harness accepts no arguments.');
  process.exitCode = 64;
} else {
  runWorkerHarness().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'OpenKit Worker Harness failed.';
    console.error(message);
    process.exitCode = 1;
  });
}
