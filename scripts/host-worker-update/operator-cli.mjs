#!/usr/bin/env node
/** Explicit optional administrator CLI; it supplies no default deployment or recovery path. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createOperatorLive, readOperatorJson } from './operator-live.mjs';
import { admitComponentParameters, updateComponents } from './update-components.mjs';

const usage =
  'Usage: operator-cli.mjs --target HTTPS_ORIGIN --params PRIVATE_JSON --deployment-record PRIVATE_JSON --grant PRIVATE_JSON --artifacts PRIVATE_JSON --evidence-dir NEW_PRIVATE_DIRECTORY';
const failure =
  'Operator update unavailable; inspect separate private evidence before any new effect.';

/**
 * Parse the explicit invocation before any private file, credential or host operation.
 * @param {string[]} args Command arguments, never interpolated into host commands.
 * @param {object} adapters Optional contained test boundaries for files and composition.
 * @returns {Promise<number>} Zero for complete component evidence, two for usage, one for unavailable work.
 */
export async function runOperatorCli(args, adapters = {}) {
  const stdout = adapters.stdout ?? ((value) => process.stdout.write(value));
  const stderr = adapters.stderr ?? ((value) => process.stderr.write(value));
  let values;
  try {
    const parsed = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      tokens: true,
      options: {
        target: { type: 'string' },
        params: { type: 'string' },
        'deployment-record': { type: 'string' },
        grant: { type: 'string' },
        artifacts: { type: 'string' },
        'evidence-dir': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    const names = parsed.tokens
      .filter((token) => token.kind === 'option')
      .map((token) => token.name);
    if (new Set(names).size !== names.length) throw Error();
    if (parsed.values.help && names.length === 1) {
      stdout(`${usage}\n`);
      return 0;
    }
    if (
      parsed.values.help ||
      !['target', 'params', 'deployment-record', 'grant', 'artifacts', 'evidence-dir'].every(
        (key) => typeof parsed.values[key] === 'string' && parsed.values[key].length > 0
      )
    )
      throw Error();
    values = parsed.values;
    const url = new URL(values.target);
    if (
      url.protocol !== 'https:' ||
      url.origin !== values.target ||
      url.username ||
      url.password ||
      url.hostname === 'a2'
    )
      throw Error();
    for (const key of ['params', 'deployment-record', 'grant', 'artifacts', 'evidence-dir']) {
      if (!path.isAbsolute(values[key]) || path.normalize(values[key]) !== values[key])
        throw Error();
    }
  } catch {
    stderr(`${usage}\n`);
    return 2;
  }
  try {
    const p = admitComponentParameters(
      await (adapters.readJson ?? readOperatorJson)(values.params)
    );
    const evidence = values['evidence-dir'];
    try {
      await fs.lstat(evidence);
      throw Error(failure);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const io = await (adapters.createLive ?? createOperatorLive)(values.target, {
      params: p,
      deploymentRecordFile: values['deployment-record'],
      grantFile: values.grant,
      artifactsFile: values.artifacts,
      privateWorkDir: `${evidence}.inputs`,
    });
    const result = await (adapters.compose ?? updateComponents)(values.target, p, evidence, io);
    if (result?.outcome !== 'passed') throw Error(failure);
    stdout(`${JSON.stringify(result)}\n`);
    return 0;
  } catch {
    stderr(`${failure}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runOperatorCli(process.argv.slice(2));
}
