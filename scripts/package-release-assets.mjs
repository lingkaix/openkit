#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseVersionTag } from './release-preflight.mjs';

/**
 * Archives the complete end-user Skill and writes its portable checksum.
 *
 * @param {object} input Packaging input.
 * @param {string} input.repoRoot Repository root.
 * @param {string} input.tag Product release tag.
 * @param {string} [input.ref] Git revision to archive.
 * @param {string} input.outputDir Destination directory.
 * @returns {{ archivePath: string, checksumPath: string, checksum: string }} Produced assets.
 */
export function packageReleaseAssets(input) {
  parseVersionTag(input.tag);
  const ref = input.ref ?? 'HEAD';
  if (!/^[0-9A-Za-z][0-9A-Za-z._/-]*$/.test(ref)) {
    throw new Error(`Git revision contains unsupported characters: ${ref}`);
  }

  const repoRoot = resolve(input.repoRoot);
  const outputDir = resolve(input.outputDir);
  const archiveName = `openkit-skill-${input.tag}.tar.gz`;
  const archivePath = resolve(outputDir, archiveName);
  const checksumPath = resolve(outputDir, 'SHA256SUMS');
  mkdirSync(outputDir, { recursive: true });

  const result = spawnSync(
    'git',
    [
      'archive',
      '--format=tar.gz',
      `--prefix=openkit-skill-${input.tag}/`,
      `--output=${archivePath}`,
      ref,
      '--',
      'LICENSE',
      'skills/openkit',
    ],
    { cwd: repoRoot, encoding: 'utf8' }
  );
  if (result.status !== 0) {
    throw new Error(
      `Unable to archive release assets: ${result.stderr.trim() || result.stdout.trim()}`
    );
  }

  const checksum = createHash('sha256').update(readFileSync(archivePath)).digest('hex');
  writeFileSync(checksumPath, `${checksum}  ${archiveName}\n`);
  return { archivePath, checksumPath, checksum };
}

/**
 * Parses packaging CLI flags.
 *
 * @param {string[]} argv CLI argv without node and script.
 * @returns {Record<string, string>} Parsed flags.
 */
function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      continue;
    }
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    const value = argv[++index];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}.`);
    }
    args[key] = value;
  }
  return args;
}

/** Runs the portable release packager CLI. */
function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = packageReleaseAssets({
    outputDir: String(args['output-dir'] ?? 'dist/release'),
    ref: String(args.ref ?? 'HEAD'),
    repoRoot: String(args['repo-root'] ?? process.cwd()),
    tag: String(args.tag ?? process.env.GITHUB_REF_NAME ?? ''),
  });
  console.log(`Release Skill archive: ${result.archivePath}`);
  console.log(`Release checksum: ${result.checksum}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
