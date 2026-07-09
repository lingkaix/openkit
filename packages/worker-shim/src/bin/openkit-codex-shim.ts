#!/usr/bin/env node
import { runCodexShimCli } from '../cli.js';

runCodexShimCli(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'OpenKit Codex shim failed.';
  console.error(message);
  process.exitCode = 1;
});
