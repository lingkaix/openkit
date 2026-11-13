#!/usr/bin/env node
/** Verify controlled release SBOMs and GitHub-keyless provenance with the native Sigstore verifier. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parseVersionTag } from './release-preflight.mjs';
import { assertSbom, provenanceSubjects, sbomAssetNames, sbomName } from './release-sbom.mjs';
import { publishedImages } from './release-security.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** This is verification, never a new signer/issuer configuration surface. */
function signerConstraints({ repository, tag, sha }) {
  const version = parseVersionTag(tag);
  if (
    !/^[a-f0-9]{40}$/u.test(sha ?? '') ||
    (repository !== 'lingkaix/openkit' &&
      !(repository === 'notrucked/openkit' && /^v0\.0\.\d+(?:-[a-z0-9.-]+)?$/u.test(tag)))
  )
    throw Error('Release attestation namespace refused');
  const workflow = version.includes('-') ? 'ci.yml' : 'release-promotion.yml';
  return [
    '--repo',
    repository,
    '--signer-workflow',
    `${repository}/.github/workflows/${workflow}`,
    '--source-ref',
    `refs/tags/${tag}`,
    '--source-digest',
    sha,
    '--cert-oidc-issuer',
    'https://token.actions.githubusercontent.com',
    '--deny-self-hosted-runners',
    '--predicate-type',
    'https://slsa.dev/provenance/v1',
  ];
}
export function attestationArguments(input) {
  if (typeof input.subject !== 'string' || !input.subject || input.subject.includes('\0'))
    throw Error('Attestation subject required');
  return ['attestation', 'verify', input.subject, ...signerConstraints(input)];
}
function verifyNative(input) {
  const result = spawnSync('gh', attestationArguments(input), {
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GH_TOKEN: process.env.GH_TOKEN,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      DOCKER_CONFIG: process.env.DOCKER_CONFIG,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0)
    throw Error('Native release attestation verification refused');
}
/** Shared manifest/checksum verification happens before any package inventory is admitted. */
export function verifyReleaseIntegrity({
  directory,
  repository,
  tag,
  sha,
  repoRoot = process.cwd(),
}) {
  // Validate the fixed signer namespace before even reading a supplied artifact projection.
  signerConstraints({ repository, tag, sha });
  const manifest = publishedImages({ directory, repository, sha, repoRoot });
  if (
    manifest.tag !== tag &&
    !(parseVersionTag(tag).includes('-') === false && manifest.tag.startsWith(`${tag}-`))
  )
    throw Error('Release/source tag relationship refused');
  const required = sbomAssetNames(manifest.tag);
  if (
    !required.every((name) => manifest.assets.filter((asset) => asset.name === name).length === 1)
  )
    throw Error('Complete SBOM attachment set required');
  for (const image of manifest.images) {
    for (const entry of image.platforms) {
      const name = sbomName(image.id, entry.platform, manifest.tag);
      const bom = JSON.parse(readFileSync(join(directory, name), 'utf8'));
      assertSbom(bom, {
        kind: 'image',
        id: image.id,
        platform: entry.platform,
        sha,
        ...(image.id === 'app' ? {} : { reference: `${image.image}@${entry.digest}` }),
      });
    }
  }
  for (const architecture of ['amd64', 'arm64']) {
    const platform = `linux/${architecture}`;
    const archive = join(
      directory,
      `openkit-nanohost-${manifest.tag}-linux-${architecture}.tar.gz`
    );
    const bom = JSON.parse(
      readFileSync(join(directory, sbomName('nanohost', platform, manifest.tag)), 'utf8')
    );
    assertSbom(bom, {
      kind: 'archive',
      id: 'nanohost',
      platform,
      sha,
      reference: `sha256:${hash(readFileSync(archive))}`,
    });
  }
  const subjects = provenanceSubjects({ manifest, assetsDir: directory }).trimEnd().split('\n');
  for (const line of subjects) {
    const match = /^([a-f0-9]{64}) {2}(.+)$/u.exec(line);
    if (!match) throw Error('Controlled provenance subject refused');
    const reference = match[2];
    const subject = reference.startsWith('ghcr.io/')
      ? `oci://${reference}`
      : join(directory, reference);
    verifyNative({ subject, repository, tag, sha });
  }
  console.log(
    `Release integrity verified: ${required.length} SBOMs, ${subjects.length} signed subjects`
  );
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({
      options: {
        directory: { type: 'string' },
        repository: { type: 'string' },
        tag: { type: 'string' },
        sha: { type: 'string' },
        'repo-root': { type: 'string' },
      },
    });
    verifyReleaseIntegrity({
      directory: resolve(values.directory),
      repository: values.repository,
      tag: values.tag,
      sha: values.sha,
      repoRoot: resolve(values['repo-root'] ?? '.'),
    });
  } catch {
    console.error('Release integrity verification refused; no private input was printed');
    process.exitCode = 1;
  }
}
