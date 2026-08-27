#!/usr/bin/env node
import { runWorkerShimCli } from '../cli.js';
import { runWorkerHarness } from '../harness.js';

const argv = process.argv.slice(2);
if (argv.length > 0) {
  process.stdout.write('OPENKIT_WORKER_SHIM_ENTRY_V1\n');
}
const run = argv.length === 0 ? runWorkerHarness() : runWorkerShimCli(argv);
run.catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'OpenKit worker shim failed.';
  console.error(message);
  process.exitCode = 1;
});
