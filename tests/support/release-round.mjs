#!/usr/bin/env node
/** One release-round entry point; summarize is strictly offline. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize } from './release-round/evidence.mjs';
import { decide, prepare, round } from './release-round/live.mjs';

/** Parse only the four declared commands; live commands use pinned private evidence inputs. */
export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || !args.length) {
    process.stdout.write(
      'Usage: node tests/support/release-round.mjs prepare --params FILE --evidence-dir NEW_DIR\n       round --evidence-dir DIR\n       decide --evidence-dir DIR --request ID --decision grant|deny\n       summarize --evidence-dir DIR [--legacy-prefix PREFIX] [--adjudications FILE]\n'
    );
    return;
  }
  const command = args.shift(),
    allowed = {
      prepare: ['params', 'evidence-dir'],
      round: ['evidence-dir'],
      decide: ['evidence-dir', 'request', 'decision'],
      summarize: ['evidence-dir', 'legacy-prefix', 'adjudications'],
    }[command];
  if (!allowed) throw Error('Unknown subcommand');
  const options = {};
  while (args.length) {
    const key = args.shift();
    if (
      !key.startsWith('--') ||
      !allowed.includes(key.slice(2)) ||
      Object.hasOwn(options, key.slice(2))
    )
      throw Error('Unknown or duplicate option');
    const value = args.shift();
    if (!value || value.startsWith('--')) throw Error('Missing option value');
    options[key.slice(2)] = value;
  }
  if (!options['evidence-dir']) throw Error('--evidence-dir required');
  const dir = path.resolve(options['evidence-dir']);
  let result;
  if (command === 'prepare') {
    if (!options.params) throw Error('--params required');
    result = await prepare(path.resolve(options.params), dir);
  }
  if (command === 'round') result = await round(dir);
  if (command === 'decide') {
    if (!options.request || !options.decision) throw Error('--request and --decision required');
    result = await decide(dir, options.request, options.decision);
  }
  if (command === 'summarize')
    result = await summarize(dir, {
      legacyPrefix: options['legacy-prefix'],
      adjudicationsFile: options.adjudications,
    });
  process.stdout.write(
    `${JSON.stringify({ command, status: result?.classified === false ? 'unclassified' : 'recorded', counts: result?.counts, complete: result?.complete, clean: result?.clean })}\n`
  );
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
