#!/usr/bin/env node
/** Cheap local/CI checks over the selected Git bytes, and all-lock release admission. */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gitCommit, gitNames, readGit, scanSecrets, secretDiagnostic } from './check-secrets.mjs';
import { changedFiles, checkWorkflows } from './check-workflows.mjs';
import { CREDENTIAL_PATTERN } from './credential-patterns.mjs';
import { assertReleaseFindingGate, releaseFindingRecord } from './security-findings.mjs';
import {
  findingsFromOsvSource,
  kevIds,
  newSevereFindings,
  runOsv,
  scanImage,
} from './security-scan.mjs';

const lockName =
  /(?:^|\/)(?:[^/]*[.-]lock(?:\.[^/]*)?|bun\.lockb|npm-shrinkwrap\.json|go\.sum|requirements(?:-[^/]*)?\.txt)$/u;
const workflow = (file) => /^\.github\/workflows\/[^/]+\.ya?ml$/u.test(file);
/** Dependency lock discovery is Git-backed; an unsupported newly committed lock fails the tool. */
export function isLockfile(file) {
  return lockName.test(file) || file === 'containers/workers/python-tools.txt';
}

/** Materialize only declared lock/workflow blobs, never follow repository symlinks. */
function snapshot(repoRoot, root, selection, staged) {
  const files = gitNames(
    readGit(
      repoRoot,
      staged ? ['ls-files', '--cached', '-z'] : ['ls-tree', '-r', '--name-only', '-z', selection]
    )
  );
  const locks = [];
  for (const file of files.filter((file) => isLockfile(file) || workflow(file))) {
    // Preserve this hash-locked input's bytes and identity under the native requirements filename.
    const nativePath =
      file === 'containers/workers/python-tools.txt'
        ? '.security-inputs/python-tools/requirements.txt'
        : file;
    const target = resolve(root, nativePath);
    if (!target.startsWith(`${resolve(root)}${sep}`)) throw Error('Invalid selected Git location');
    const bytes = readGit(
      repoRoot,
      ['cat-file', 'blob', staged ? `:${file}` : `${selection}:${file}`],
      null
    );
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes, { flag: 'wx' });
    if (isLockfile(file))
      locks.push({
        path: target,
        location: file,
        artifact: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      });
  }
  return locks;
}

/** Read a current structured exploitation source without accepting advisory prose as evidence. */
async function currentKev() {
  const response = await fetch(
    'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json',
    { signal: AbortSignal.timeout(30000) }
  );
  if (!response.ok) throw Error('Structured exploitation source unavailable');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 16 * 1024 * 1024) throw Error('Structured exploitation source too large');
  return kevIds(JSON.parse(bytes.toString('utf8')));
}

/** One native invocation gives both sides the same advisory observation. */
function scanLocks(root, before, after, knownCves) {
  const inputs = [
    ...before.map((value) => ({ ...value, side: 'before' })),
    ...after.map((value) => ({ ...value, side: 'after' })),
  ];
  const result = { before: [], after: [] };
  if (!inputs.length) return result;
  const env = {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    HOME: root,
    DOCKER_CONFIG: root,
  };
  const config = join(root, 'scanner.toml');
  writeFileSync(config, '', { flag: 'wx' });
  const args = [
    'scan',
    'source',
    '--format',
    'json',
    '--all-packages',
    '--config',
    config,
    ...inputs.flatMap((value) => ['-L', value.path]),
  ];
  const report = runOsv(args, { cwd: root, env });
  const byPath = new Map(inputs.map((value) => [value.path, value]));
  const observed = new Set();
  for (const source of report.results) {
    if (typeof source.source?.path !== 'string')
      throw Error('Dependency scan lost its source binding');
    const input = byPath.get(resolve(root, source.source.path));
    if (!input) throw Error('Dependency scan returned an unselected source');
    observed.add(input.path);
    result[input.side].push(...findingsFromOsvSource(source, { ...input, knownCves }));
  }
  if (inputs.some((input) => !observed.has(input.path)))
    throw Error('Dependency scan omitted a selected lock file');
  return result;
}

/** Print only public advisory/package identity, not private judgments or scanner source text. */
function reportFinding(finding) {
  const safe = (value) => JSON.stringify(value.replace(CREDENTIAL_PATTERN, '[redacted]'));
  const name = finding.component.purl.split('@')[0].replace(/^pkg:[^/]+\//u, '');
  console.log(`Dependency finding ${finding.class}: ${safe(finding.id)} ${safe(name)}`);
}

/** Check the selected candidate without changing Git, installing dependencies or running package code. */
export async function checkSecurity({
  repoRoot = process.cwd(),
  staged = false,
  base,
  head = 'HEAD',
  release = false,
  register,
  now = Date.now(),
} = {}) {
  if (staged && release) throw Error('A staged index is not a release commit');
  if (release && !base)
    throw Error(
      'Release security check requires its previous tag or explicit EMPTY first-release base'
    );
  // EMPTY is the explicit first-release diff: scan its whole current tree, not removed history.
  const matches = scanSecrets({
    repoRoot,
    staged,
    snapshot: release && base === 'EMPTY',
    base,
    head,
  });
  for (const match of matches) console.error(secretDiagnostic(match));
  if (matches.length)
    throw Error('Known credential forms found; revoke or rotate leaked credentials first');
  const changed = release ? [] : changedFiles({ repoRoot, staged, base, head });
  const lint = release || changed.some(workflow);
  const dependencies = release || changed.some(isLockfile);
  if (!lint && !dependencies) return;
  const temporary = mkdtempSync(join(tmpdir(), 'openkit-security-'));
  try {
    const end = staged ? undefined : gitCommit(repoRoot, head);
    const currentRoot = join(temporary, 'candidate');
    mkdirSync(currentRoot);
    const after = snapshot(repoRoot, currentRoot, end, staged);
    if (lint) checkWorkflows({ repoRoot: currentRoot, all: true });
    if (!dependencies) return;
    const previousRoot = join(temporary, 'baseline');
    mkdirSync(previousRoot);
    const previous = release
      ? []
      : snapshot(
          repoRoot,
          previousRoot,
          gitCommit(repoRoot, staged ? 'HEAD' : (base ?? 'HEAD^')),
          false
        );
    const knownCves = previous.length || after.length ? await currentKev() : new Set();
    const findings = scanLocks(temporary, previous, after, knownCves);
    findings.after.forEach(reportFinding);
    if (release) assertReleaseFindingGate({ findings: findings.after, register, now });
    else if (newSevereFindings(findings.before, findings.after).length)
      throw Error('Change introduces a new K, C or H dependency match');
    return findings.after;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** Read-only candidate/daily image checks. Only the candidate form admits a release. */
export async function checkImages({ images, release = false, register, now = Date.now() }) {
  if (!Array.isArray(images) || !images.length)
    throw Error('Image scan requires exact platform manifests');
  const temporary = mkdtempSync(join(tmpdir(), 'openkit-image-security-'));
  try {
    const config = join(temporary, 'scanner.toml');
    writeFileSync(config, '', { flag: 'wx' });
    const knownCves = await currentKev();
    const env = {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      HOME: process.env.HOME,
      DOCKER_CONFIG: process.env.DOCKER_CONFIG,
    };
    const findings = images.flatMap(({ image, platform }) =>
      scanImage({ image, platform, knownCves, cwd: temporary, env, config })
    );
    findings.forEach(reportFinding);
    if (release) assertReleaseFindingGate({ findings, register, now });
    return findings;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({
      options: {
        staged: { type: 'boolean' },
        base: { type: 'string' },
        head: { type: 'string' },
        release: { type: 'boolean' },
        'public-record': { type: 'string' },
        'images-only': { type: 'boolean' },
        image: { type: 'string', multiple: true },
      },
    });
    const register =
      values.release && process.env.OPENKIT_SECURITY_FINDINGS
        ? JSON.parse(process.env.OPENKIT_SECURITY_FINDINGS)
        : undefined;
    if (values['public-record'] && (!values.release || values['images-only'] || values.image))
      throw Error('A public source record requires release admission');
    if (!values['images-only']) {
      const findings = await checkSecurity({ ...values, register });
      if (values['public-record'])
        writeFileSync(
          values['public-record'],
          releaseFindingRecord({ findings, register, now: Date.now() }),
          { flag: 'wx' }
        );
    }
    if (values.image || values['images-only']) {
      const images = (values.image ?? []).map((value) => {
        const separator = value.indexOf('=');
        if (separator < 0) throw Error('Image selection requires platform=immutable-reference');
        return { platform: value.slice(0, separator), image: value.slice(separator + 1) };
      });
      await checkImages({ images, release: values.release, register });
    }
  } catch {
    console.error('Security check refused; no private assessment was printed');
    process.exitCode = 1;
  }
}
