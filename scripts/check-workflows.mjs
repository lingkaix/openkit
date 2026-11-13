#!/usr/bin/env node
/** Run the pinned workflow linter without printing source text or credential values. */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import toolPins from './security-tools.json' with { type: 'json' };

/** Read the selected Git change, including staged file contents at pre-commit. */
export function changedFiles({
  repoRoot = process.cwd(),
  staged = false,
  base,
  head = 'HEAD',
} = {}) {
  let args;
  if (staged) args = ['diff', '--cached', '--name-only', '-z'];
  else if (base) args = ['diff', '--name-only', '-z', base, head];
  else {
    const parent = spawnSync('git', ['rev-parse', '--verify', `${head}^`], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    args =
      parent.status === 0 ? ['diff', '--name-only', '-z', `${head}^`, head] : ['ls-files', '-z'];
  }
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) throw Error('Security check cannot read the selected Git change');
  return result.stdout.split('\0').filter(Boolean);
}

/** Lint all workflows when their graph changes, or unconditionally for release admission. */
export function checkWorkflows({ repoRoot = process.cwd(), all = false, files } = {}) {
  if (
    !all &&
    !(files ?? changedFiles({ repoRoot })).some((file) => file.startsWith('.github/workflows/'))
  )
    return;
  // Offline lint needs no credentials. In particular, an empty token is not an unset token.
  const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, ZIZMOR_OFFLINE: 'true' };
  const version = spawnSync('zizmor', ['--version'], { encoding: 'utf8', env });
  if (version.status !== 0 || version.stdout.trim() !== `zizmor ${toolPins.zizmor.version}`)
    throw Error('Pinned zizmor is required; install the committed security tools');
  const result = spawnSync(
    'zizmor',
    ['--offline', '--format', 'json', '--no-progress', '.github/workflows'],
    {
      cwd: resolve(repoRoot),
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env,
    }
  );
  if (result.error || result.status === null)
    throw Error('Pinned zizmor is required; install the committed security tools');
  let findings;
  try {
    findings = JSON.parse(result.stdout);
  } catch {
    throw Error('Workflow lint returned no valid report');
  }
  if (!Array.isArray(findings)) throw Error('Workflow lint returned an invalid report');
  const active = findings.filter((finding) => !finding.ignored);
  for (const finding of active) {
    const location = finding.locations?.[0];
    const file = location?.symbolic?.key?.Local?.verbatim_path ?? '.github/workflows';
    const line = (location?.concrete?.location?.start_point?.row ?? 0) + 1;
    console.error(
      `${JSON.stringify(file)}:${line}: ${finding.ident} (${finding.determinations?.severity ?? 'unknown'})`
    );
  }
  if (result.status !== 0 || active.length)
    throw Error(`Workflow lint refused (${active.length} findings)`);
  console.log('Workflow lint passed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({
      options: {
        all: { type: 'boolean' },
        staged: { type: 'boolean' },
        base: { type: 'string' },
        head: { type: 'string' },
      },
    });
    checkWorkflows({
      all: values.all,
      files: values.all
        ? undefined
        : changedFiles({ staged: values.staged, base: values.base, head: values.head }),
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
