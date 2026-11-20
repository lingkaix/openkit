#!/usr/bin/env node
/** Verify controlled release SBOMs and GitHub-keyless provenance with the native Sigstore verifier. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { isDirectStableTag, parseVersionTag } from './release-preflight.mjs';
import { assertSbom, provenanceSubjects, sbomAssetNames, sbomName } from './release-sbom.mjs';
import { indexPlatforms, observeIndex, publishedImages } from './release-security.mjs';

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
  const workflow =
    version.includes('-') || isDirectStableTag(tag) ? 'ci.yml' : 'release-promotion.yml';
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
/**
 * Candidate OCI subjects before any release tag: the admitted index and its exact platform
 * manifests, in the published subject inventory's checksum form.
 */
export function candidateSubjects({ image, digest, platforms, observe = observeIndex }) {
  const manifests = indexPlatforms(observe(image, digest), platforms);
  return `${[digest, ...manifests.map((entry) => entry.digest)]
    .map((value) => `${value.slice(7)}  ${image}@${value}`)
    .sort()
    .join('\n')}\n`;
}
/** Every candidate subject must carry verified keyless provenance before publishers may tag it. */
export function verifyCandidateSubjects({ subjects, repository, tag, sha, verify = verifyNative }) {
  signerConstraints({ repository, tag, sha });
  const lines = subjects.trimEnd().split('\n');
  for (const line of lines) {
    const match = /^([a-f0-9]{64}) {2}(ghcr\.io\/[a-z0-9._/-]+@sha256:\1)$/u.exec(line);
    if (!match) throw Error('Candidate provenance subject refused');
    verify({ subject: `oci://${match[2]}`, repository, tag, sha });
  }
  return lines.length;
}
/** Check the manifest, SBOMs, checksum and subject identity before any signing effect. */
export function releaseIntegritySubjects({
  directory,
  repository,
  tag,
  sha,
  repoRoot = process.cwd(),
  expectedSource,
}) {
  // Validate the fixed signer namespace before even reading a supplied artifact projection.
  signerConstraints({ repository, tag, sha });
  const manifest = publishedImages({ directory, repository, sha, repoRoot, expectedSource });
  if (
    manifest.tag !== tag &&
    !(
      !isDirectStableTag(tag) &&
      !parseVersionTag(tag).includes('-') &&
      manifest.tag.startsWith(`${tag}-`)
    )
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
  return {
    manifest,
    count: required.length,
    subjects: provenanceSubjects({ manifest, assetsDir: directory }),
  };
}

/** Bind the downloaded checksum list to the selected candidate, even when C is unchanged. */
export function verifyCandidateBundleChecksum({ proof, bytes, repository, tag, sha }) {
  if (
    !proof ||
    proof.repository !== repository ||
    proof.tag !== tag ||
    proof.sha !== sha ||
    proof.checksums !== hash(bytes)
  )
    throw Error('Published bundle differs from the selected stable candidate');
}

/** Verify the published subject set with the actual tag's keyless signing identity. */
export function verifyReleaseIntegrity(input) {
  const { directory, repository, tag, sha, candidateProof } = input;
  if (isDirectStableTag(tag))
    verifyCandidateBundleChecksum({
      proof: candidateProof,
      bytes: readFileSync(join(directory, 'SHA256SUMS')),
      repository,
      tag,
      sha,
    });
  const { manifest, count, subjects: inventory } = releaseIntegritySubjects(input);
  const subjects = inventory.trimEnd().split('\n');
  for (const line of subjects) {
    const match = /^([a-f0-9]{64}) {2}(.+)$/u.exec(line);
    if (!match) throw Error('Controlled provenance subject refused');
    const reference = match[2];
    const subject = reference.startsWith('ghcr.io/')
      ? `oci://${reference}`
      : join(directory, reference);
    verifyNative({ subject, repository, tag, sha });
  }
  console.log(`Release integrity verified: ${count} SBOMs, ${subjects.length} signed subjects`);
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
        image: { type: 'string' },
        digest: { type: 'string' },
        platforms: { type: 'string' },
        subjects: { type: 'string' },
        'verify-subjects': { type: 'string' },
        'candidate-proof': { type: 'string' },
      },
    });
    if (values.image) {
      signerConstraints(values);
      const subjects = candidateSubjects({
        image: values.image,
        digest: values.digest,
        platforms: values.platforms?.split(','),
      });
      writeFileSync(values.subjects, subjects, { flag: 'wx' });
    } else if (values['verify-subjects']) {
      const count = verifyCandidateSubjects({
        subjects: readFileSync(values['verify-subjects'], 'utf8'),
        repository: values.repository,
        tag: values.tag,
        sha: values.sha,
      });
      console.log(`Candidate provenance verified: ${count} signed subjects`);
    } else
      verifyReleaseIntegrity({
        directory: resolve(values.directory),
        repository: values.repository,
        tag: values.tag,
        sha: values.sha,
        repoRoot: resolve(values['repo-root'] ?? '.'),
        candidateProof: values['candidate-proof']
          ? JSON.parse(readFileSync(values['candidate-proof'], 'utf8'))
          : undefined,
      });
  } catch {
    console.error('Release integrity verification refused; no private input was printed');
    process.exitCode = 1;
  }
}
