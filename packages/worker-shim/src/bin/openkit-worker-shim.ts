#!/usr/bin/env node
import { runWorkerShimCli } from '../cli.js';

runWorkerShimCli(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'OpenKit worker shim failed.';
  console.error(message);
  process.exitCode = 1;
});
