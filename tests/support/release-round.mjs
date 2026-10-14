#!/usr/bin/env node
/** One release-round entry point; summarize is strictly offline. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize } from './release-round/evidence.mjs';
import { prepare, round } from './release-round/live.mjs';
import { readJson } from './release-round/safety.mjs';

/** Parse the three declared commands. */
export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || !args.length) {
    process.stdout.write(
      'Usage: node tests/support/release-round.mjs prepare --target ALIAS_OR_URL --params FILE --evidence-dir NEW_DIR\n       round --target ALIAS_OR_URL --evidence-dir DIR\n       summarize --evidence-dir DIR [--adjudications FILE]\n'
    );
    return;
  }
  const command = args.shift(),
    allowed = {
      prepare: ['params', 'evidence-dir', 'target'],
      round: ['evidence-dir', 'target'],
      summarize: ['evidence-dir', 'adjudications'],
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
  if (command !== 'summarize') {
    if (!options.target) throw Error('--target required; no default deployment');
    const p = await readJson(
      command === 'prepare' ? options.params : path.join(dir, 'params.json')
    );
    if (options.target === 'a2' || ![p.deployment.sshAlias, p.cli.origin].includes(options.target))
      throw Error('Target outside pinned qualification binding');
  }
  let result;
  if (command === 'prepare') {
    if (!options.params) throw Error('--params required');
    result = await prepare(path.resolve(options.params), dir);
  }
  if (command === 'round') {
    await round(dir);
    result = await summarize(dir);
  }
  if (command === 'summarize')
    result = await summarize(dir, { adjudicationsFile: options.adjudications });
  process.stdout.write(
    `${JSON.stringify({ command, status: result?.classified === false ? 'unclassified' : 'recorded', counts: result?.counts, complete: result?.complete, clean: result?.clean })}\n`
  );
  if (result?.rows && !result.rows.every((row) => row.code === 'P')) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
