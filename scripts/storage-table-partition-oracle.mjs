#!/usr/bin/env node
/**
 * Report-mode table-partition oracle.
 *
 * Applies each signed owner journal to a fresh in-memory database and compares
 * application tables with Appendix A. Only a real sqlite_ prefix is metadata.
 * Destination journals may include one <owner>_intents table. Kernel DDL fails
 * when a table, column, check, seed, index, or index predicate names discord,
 * guild, or a retired product predicate. A failing report still exits 0.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluatePartition, formatPartition } from './lib/storage-fitness-oracles.mjs';

const USAGE = `Usage: node scripts/storage-table-partition-oracle.mjs [--root REPOSITORY]\n`;

export function main(
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr
) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    stdout.write(USAGE);
    return 0;
  }
  if (parsed.error) {
    stderr.write(`${parsed.error}\n${USAGE}`);
    return 2;
  }
  stdout.write(formatPartition(evaluatePartition(parsed.root)));
  return 0;
}

function parseArgs(argv) {
  let root = process.cwd();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') return { help: true };
    if (argument === '--root') {
      const value = argv[index + 1];
      if (!value) return { error: '--root requires a path' };
      root = resolve(value);
      index += 1;
      continue;
    }
    return { error: `unknown argument ${argument}` };
  }
  return { root };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
