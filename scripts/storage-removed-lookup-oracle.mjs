#!/usr/bin/env node
/**
 * Report-mode removed-lookup oracle.
 *
 * Scans apps/nanocore/src for SQL and DAL references outside the file owner.
 * Retired and old table names are REMOVED hits from any owner. A missing or empty
 * scan root is INCOMPLETE. Zero hits print NO-HITS and are not a reachability proof.
 * A typed CoreDb or WorkspaceDb on receiver.sqlite, or on the receiver of a
 * same-function string binding, wins over the path owner. This scan does not
 * resolve cross-file imports or re-export barrels. A failing report still
 * exits 0. The word PASS is not a lookup verdict.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluateLookups, formatLookups } from './lib/storage-fitness-oracles.mjs';

const USAGE = `Usage: node scripts/storage-removed-lookup-oracle.mjs [--root REPOSITORY]\n`;

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
  stdout.write(formatLookups(evaluateLookups(parsed.root)));
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
