#!/usr/bin/env node
import { runWorkerSidecarCli } from '../cli.js';

runWorkerSidecarCli(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'OpenKit worker sidecar failed.';
  console.error(message);
  process.exitCode = 1;
});
