#!/usr/bin/env node
/** Read-only candidate/published finding admission; no register or publication effects. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { checkImages, checkSecurity } from './check-security.mjs';
import { imageIdentity, verifyIndex } from './release-candidate.mjs';
import { parseVersionTag } from './release-preflight.mjs';
import { readPublishedManifest } from './release-record.mjs';
import { releaseFindingRecord } from './security-findings.mjs';

const sha256 = /^sha256:[a-f0-9]{64}$/u;
/** Capture only known public observations; raw failure output is never retained. */
function run(command, args, cwd) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    throw Error('Release security observation unavailable');
  }
}
/** Project observed descriptors through the existing index/platform equality predicate. */
export function indexPlatforms(index, expected) {
  if (
    !Array.isArray(expected) ||
    !expected.length ||
    new Set(expected).size !== expected.length ||
    expected.some((p) => !/^linux\/(?:amd64|arm64)$/u.test(p)) ||
    !Array.isArray(index?.manifests)
  )
    throw Error('Invalid candidate platform set');
  const platforms = expected.map((platform) => {
    const descriptor = index.manifests.find(
      (item) => `${item.platform?.os}/${item.platform?.architecture}` === platform
    );
    if (!sha256.test(descriptor?.digest ?? '')) throw Error('Candidate platform digest missing');
    return { platform, digest: descriptor.digest };
  });
  verifyIndex({ platforms }, index);
  return platforms;
}
/** Observe an immutable index, not the mutable release alias. */
function observeIndex(image, digest) {
  if (!/^ghcr\.io\/[a-z0-9._/-]+$/u.test(image) || !sha256.test(digest))
    throw Error('Exact image identity required');
  return JSON.parse(
    run('docker', ['buildx', 'imagetools', 'inspect', '--raw', `${image}@${digest}`])
  );
}
/** Keep only public advisory identifiers in the existing Markdown release-record surface. */
function publicFindingRecord(file, findings, register) {
  if (file)
    writeFileSync(file, releaseFindingRecord({ findings, register, now: Date.now() }), {
      flag: 'wx',
    });
}
/** Admit precisely the selected candidate; the digest remains the sole publication binding. */
export async function scanReleaseIndex({
  image,
  digest,
  platforms,
  register,
  output,
  publicRecord,
}) {
  if (typeof output !== 'string' || !output) throw Error('Admitted digest output required');
  const manifests = indexPlatforms(observeIndex(image, digest), platforms);
  const findings = await checkImages({
    images: manifests.map((entry) => ({
      platform: entry.platform,
      image: `${image}@${entry.digest}`,
    })),
    release: true,
    register,
  });
  // The immutable Actions artifact's current run/attempt and image-id name supply workflow scope.
  // Publishers consume this same digest; they never reselect another candidate after admission.
  writeFileSync(output, `${digest}\n`, { flag: 'wx' });
  publicFindingRecord(publicRecord, findings, register);
}
/** Verify existing publication bytes through the same reader used by stable promotion. */
export function publishedImages({ directory, repoRoot, repository, sha }) {
  const manifests = readdirSync(directory).filter((name) =>
    /^openkit-release-v[^/]+\.json$/u.test(name)
  );
  if (manifests.length !== 1) throw Error('One published source manifest required');
  const sourceTag = manifests[0].slice('openkit-release-'.length, -'.json'.length);
  parseVersionTag(sourceTag);
  const sourceCommit = run(
    'git',
    ['rev-parse', '--verify', '--end-of-options', `${sourceTag}^{commit}`],
    repoRoot
  );
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit) || (sha !== undefined && sha !== sourceCommit))
    throw Error('Published source commit mismatch');
  const temporary = mkdtempSync(join(tmpdir(), 'openkit-publication-security-'));
  try {
    return readPublishedManifest({
      repoRoot,
      assetsDir: directory,
      recordsDir: join(temporary, 'records'),
      sourceTag,
      sha: sourceCommit,
      repository,
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
/** The daily diagnostic follows the newest non-draft published release, including prereleases. */
function latestPublicTag(repository) {
  const releases = JSON.parse(
    run('gh', [
      'release',
      'list',
      '--repo',
      repository,
      '--exclude-drafts',
      '--limit',
      '1000',
      '--json',
      'tagName,publishedAt',
    ])
  );
  if (!Array.isArray(releases)) throw Error('Published release list invalid');
  if (!releases.length) return undefined;
  for (const release of releases) {
    parseVersionTag(release.tagName);
    if (
      typeof release.publishedAt !== 'string' ||
      !Number.isFinite(Date.parse(release.publishedAt))
    )
      throw Error('Published release clock invalid');
  }
  releases.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  if (releases.length > 1 && releases[0].publishedAt === releases[1].publishedAt)
    throw Error('Newest published release is ambiguous');
  return releases[0].tagName;
}
/** A main-run diagnostic consumes only this run's already-built candidate record. */
export async function scanCandidateRecord(file, repoRoot = process.cwd()) {
  const record = JSON.parse(readFileSync(file, 'utf8'));
  const definition = JSON.parse(
    readFileSync(join(repoRoot, 'containers/images.json'), 'utf8')
  ).images.find((image) => image.id === process.env.IMAGE_ID && image.release === true);
  if (
    !definition ||
    record.schemaVersion !== 1 ||
    record.repository !== process.env.GITHUB_REPOSITORY ||
    record.sha !== process.env.GITHUB_SHA ||
    record.id !== definition.id ||
    record.tag !== process.env.CANDIDATE_TAG
  )
    throw Error('Current candidate source binding failed');
  const expected = imageIdentity({
    repository: record.repository,
    sha: record.sha,
    tag: record.tag,
    created: run('git', ['show', '-s', '--format=%cI', record.sha], repoRoot),
    image: definition,
  });
  if (record.image !== expected.image) throw Error('Candidate repository binding failed');
  const index = observeIndex(record.image, record.digest);
  indexPlatforms(index, definition.platforms);
  verifyIndex(record, index);
  return checkImages({
    images: record.platforms.map((entry) => ({
      platform: entry.platform,
      image: `${record.image}@${entry.digest}`,
    })),
  });
}

/** Scan recorded platform manifests; diagnostics cannot create an admission digest. */
export async function scanPublishedImages({
  directory,
  repoRoot = process.cwd(),
  repository,
  sha,
  diagnostic = false,
  register,
  output,
  publicRecord,
}) {
  const manifest = publishedImages({ directory, repoRoot, repository, sha });
  for (const image of manifest.images) verifyIndex(image, observeIndex(image.image, image.digest));
  const sourceFindings = diagnostic
    ? []
    : await checkSecurity({
        repoRoot,
        release: true,
        base: manifest.tag,
        head: manifest.sourceCommit,
        register,
      });
  const findings = await checkImages({
    images: manifest.images.flatMap((image) =>
      image.platforms.map((entry) => ({
        platform: entry.platform,
        image: `${image.image}@${entry.digest}`,
      }))
    ),
    release: !diagnostic,
    register,
  });
  if (!diagnostic && output)
    writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  if (!diagnostic) publicFindingRecord(publicRecord, [...sourceFindings, ...findings], register);
  return findings;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let temporary;
  try {
    const { values } = parseArgs({
      options: {
        image: { type: 'string' },
        digest: { type: 'string' },
        platforms: { type: 'string' },
        output: { type: 'string' },
        'public-record': { type: 'string' },
        directory: { type: 'string' },
        repository: { type: 'string' },
        'repo-root': { type: 'string' },
        sha: { type: 'string' },
        latest: { type: 'boolean' },
        diagnostic: { type: 'boolean' },
        candidate: { type: 'string' },
      },
    });
    const register =
      !values.diagnostic && process.env.OPENKIT_SECURITY_FINDINGS
        ? JSON.parse(process.env.OPENKIT_SECURITY_FINDINGS)
        : undefined;
    if (values.latest && (!values.diagnostic || values.directory || values.image))
      throw Error('Latest-release mode is diagnostic only');
    if (values.directory && values.image) throw Error('Select one image source');
    if (
      values.candidate &&
      (!values.diagnostic || values.directory || values.latest || values.image)
    )
      throw Error('Current candidate mode is diagnostic only');
    let directory = values.directory;
    if (values.latest) {
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(values.repository ?? ''))
        throw Error('Repository identity required');
      const tag = latestPublicTag(values.repository);
      if (!tag) {
        console.log('No published release exists yet');
        process.exit(0);
      }
      temporary = mkdtempSync(join(tmpdir(), 'openkit-latest-security-'));
      directory = join(temporary, 'assets');
      mkdirSync(directory);
      run('gh', ['release', 'download', tag, '--repo', values.repository, '--dir', directory]);
    }
    if (values.candidate)
      await scanCandidateRecord(values.candidate, resolve(values['repo-root'] ?? '.'));
    else if (directory)
      await scanPublishedImages({
        directory: resolve(directory),
        repoRoot: resolve(values['repo-root'] ?? '.'),
        repository: values.repository,
        sha: values.sha,
        diagnostic: values.diagnostic,
        register,
        output: values.output,
        publicRecord: values['public-record'],
      });
    else {
      if (values.diagnostic) throw Error('Diagnostic mode cannot emit an admitted candidate');
      await scanReleaseIndex({
        ...values,
        platforms: values.platforms?.split(','),
        register,
        publicRecord: values['public-record'],
      });
    }
  } catch {
    console.error('Release security gate refused; no private assessment was printed');
    process.exitCode = 1;
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}
