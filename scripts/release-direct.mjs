#!/usr/bin/env node
/** Build and consume the attempt-bound proof used by direct stable publication. */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkSecurity } from './check-security.mjs';
import {
  inspectReleaseImageState,
  publishImageArgs,
  resolveAnonymousImageDigest,
} from './release-image-state.mjs';
import { createReleaseNotes } from './release-notes.mjs';
import { command, commitAt, observeRun } from './release-observe.mjs';
import {
  directStableGrant,
  isDirectStableTag,
  readReleaseAssessment,
  validateCandidateQualification,
} from './release-preflight.mjs';
import {
  candidateJobs,
  directCandidateJobs,
  publicationInputsAt,
} from './release-publication-check.mjs';
import { publicationManifest } from './release-record.mjs';
import { validateRegistryEvidence } from './release-registry-evidence.mjs';
import { canonical, sha } from './release-safety.mjs';
import { generateReleaseSboms, sbomAssetNames } from './release-sbom.mjs';
import { scanReleaseIndex } from './release-security.mjs';
import { assertReleaseFindingGate, releaseFindingRecord } from './security-findings.mjs';
import { readSecurityFindingRegister } from './security-register.mjs';
import { attestationArguments, releaseIntegritySubjects } from './verify-release-integrity.mjs';

const maxAgeMs = 8 * 60 * 60 * 1000;

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const catalog = () => readJson('containers/images.json').images.filter((image) => image.release);

/** Scope includes every immutable image and platform from the registry observation. */
export function candidateSecurityScope(registry) {
  return {
    repository: registry.repository,
    tag: registry.tag,
    sha: registry.sha,
    ...registry.candidate,
    images: registry.images
      .map(({ candidate: { id, digest, platforms } }) => ({
        id,
        digest,
        platforms: platforms
          .map(({ platform, digest }) => ({ platform, digest }))
          .sort((a, b) => a.platform.localeCompare(b.platform)),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** Refuse missing, mismatched and stale exports even when a scan has no K/C findings. */
export function checkedCandidateRegister(value, scope, now = Date.now()) {
  const exportValue = readSecurityFindingRegister(value);
  const validity = Date.parse(exportValue?.validUntil);
  if (
    exportValue?.schemaVersion !== 1 ||
    Object.keys(exportValue).sort().join(',') !==
      'qualification,register,schemaVersion,scope,validUntil' ||
    canonical(exportValue.scope) !== canonical(scope) ||
    !(now < validity && validity <= now + maxAgeMs)
  )
    throw Error('Exact current candidate security register required');
  const { register } = exportValue;
  if (!register) throw Error('Candidate security register required');
  assertReleaseFindingGate({ findings: [], register, now });
  return { register, validity, qualification: exportValue.qualification };
}

/** Derive the controlled attachment inventory used in the dry-run and actual GitHub write. */
export function releaseCreateArgs({ repository, tag, assetsDir, notesFile }) {
  if (repository !== 'lingkaix/openkit' || !isDirectStableTag(tag))
    throw Error('Direct GitHub Release target refused');
  return [
    'release',
    'create',
    tag,
    ...[
      'SHA256SUMS',
      `openkit-release-${tag}.json`,
      `openkit-ops-skill-${tag}.tar.gz`,
      ...['amd64', 'arm64'].map((arch) => `openkit-nanohost-${tag}-linux-${arch}.tar.gz`),
      ...sbomAssetNames(tag),
    ].map((name) => join(assetsDir, name)),
    '--repo',
    repository,
    '--verify-tag',
    '--title',
    tag,
    '--notes-file',
    notesFile,
    '--latest',
  ];
}

/** Derive image and stable alias intent using the same catalog identities as the publisher. */
function dryRunImageRecords(registry, directory) {
  mkdirSync(directory);
  for (const { candidate, index, state } of registry.images) {
    const { id, image, digest } = candidate;
    const tags = [
      registry.tag,
      registry.tag.slice(1),
      `sha-${registry.sha.slice(0, 12)}`,
      'latest',
    ];
    const record = {
      id,
      image,
      digest,
      tags,
      prerelease: false,
      platforms: candidate.platforms.map(({ platform, digest }) => ({ platform, digest })),
    };
    if (state.present) throw Error('New stable candidate requires unused image identities');
    const dryRun = command(
      'docker',
      publishImageArgs({
        image,
        digest,
        tag: registry.tag,
        sha: registry.sha,
        dryRun: true,
      })
    );
    if (canonical(JSON.parse(dryRun)) !== canonical(index))
      throw Error('Registry publication dry run changed the immutable candidate index');
    writeFileSync(join(directory, `${id}.json`), JSON.stringify(record), { flag: 'wx' });
    writeFileSync(
      join(directory, `${id}.md`),
      `### ${id}\n${[digest, ...record.platforms.map((entry) => entry.digest)].join('\n')}\n`,
      { flag: 'wx' }
    );
  }
}

/** Assemble the exact tag payload and verify its inputs with read-only authority. */
async function buildProof({ repository, tag, source, directory, registryFile, assetsDir }) {
  const registry = readJson(registryFile);
  const runId = Number(process.env.GITHUB_RUN_ID);
  const attempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  const scope = candidateSecurityScope(registry);
  const images = catalog();
  if (
    repository !== 'lingkaix/openkit' ||
    !isDirectStableTag(tag) ||
    scope.repository !== repository ||
    scope.tag !== tag ||
    scope.sha !== source ||
    scope.runId !== runId ||
    scope.attempt !== attempt ||
    commitAt('HEAD') !== source ||
    scope.images.length !== images.length ||
    images.some(
      (image) =>
        scope.images.filter(
          (entry) =>
            entry.id === image.id &&
            entry.platforms.map(({ platform }) => platform).join(',') ===
              [...image.platforms].sort().join(',')
        ).length !== 1
    ) ||
    registry.inputs !== publicationInputsAt(process.cwd(), source).sha256
  )
    throw Error('Candidate registry subject differs from this attempt');
  const { register, validity, qualification } = checkedCandidateRegister(
    process.env.OPENKIT_SECURITY_FINDINGS,
    scope
  );
  const assessment = tag === 'v0.2.0' ? readReleaseAssessment(process.cwd(), tag) : undefined;
  validateCandidateQualification(qualification, { tag, source, assessment });
  delete process.env.OPENKIT_SECURITY_FINDINGS;
  const recordsDir = join(directory, 'records');
  const securityDir = join(directory, 'security');
  mkdirSync(directory);
  mkdirSync(securityDir);
  dryRunImageRecords(registry, recordsDir);
  copyFileSync(registryFile, join(directory, 'registry-admission.json'));
  const now = Date.now();
  const findings = await checkSecurity({ head: source, release: true, register, now });
  writeFileSync(join(securityDir, 'source.md'), releaseFindingRecord({ findings, register, now }));
  const admittedFindings = [...findings];
  for (const { candidate } of registry.images) {
    const { id, image, digest, platforms } = candidate;
    const imageFindings = await scanReleaseIndex({
      image,
      digest,
      platforms: platforms.map((entry) => entry.platform),
      register,
      output: join(securityDir, `${id}.digest`),
      publicRecord: join(securityDir, `${id}.md`),
    });
    admittedFindings.push(...imageFindings);
    if (
      images.find((entry) => entry.id === id)?.anonymousPull &&
      resolveAnonymousImageDigest(`${image}@${digest}`) !== digest
    )
      throw Error('Anonymous worker base pull refused');
  }
  const identity = { repository, tag, sha: source };
  await generateReleaseSboms({ ...identity, recordsDir, assetsDir });
  publicationManifest({ ...identity, repoRoot: process.cwd(), recordsDir, assetsDir });
  const { subjects } = releaseIntegritySubjects({
    ...identity,
    directory: assetsDir,
    expectedSource: source,
  });
  for (const line of subjects.trimEnd().split('\n')) {
    const reference = line.slice(66);
    const subject = reference.startsWith('ghcr.io/')
      ? `oci://${reference}`
      : join(assetsDir, reference);
    attestationArguments({ ...identity, subject });
  }
  const notesFile = join(directory, 'release-notes.md');
  writeFileSync(
    notesFile,
    createReleaseNotes({
      ...identity,
      repoRoot: process.cwd(),
      recordsDir,
      visibility: 'public',
      checksum: sha(readFileSync(join(assetsDir, 'SHA256SUMS'))),
      runUrl: `https://github.com/${repository}/actions/runs/${runId}`,
    })
  );
  const [, , , ...args] = releaseCreateArgs({ repository, tag, assetsDir, notesFile });
  for (const file of args.slice(0, args.indexOf('--repo'))) readFileSync(file);
  const finished = Date.now();
  let expires = validity;
  assertReleaseFindingGate({
    findings: admittedFindings,
    register,
    now: finished,
    onClear: (record) => {
      if (record.decision.reviewAt !== undefined)
        expires = Math.min(expires, Date.parse(record.decision.reviewAt));
    },
  });
  if (finished >= expires) throw Error('Security proof expired during assembly');
  const validUntil = new Date(expires).toISOString();
  writeFileSync(
    join(directory, 'proof.json'),
    JSON.stringify({
      ...scope,
      inputs: registry.inputs,
      validUntil,
      checksums: sha(readFileSync(join(assetsDir, 'SHA256SUMS'))),
      qualification,
    }),
    { flag: 'wx' }
  );
}

/** Read the small public proof associated with the same complete attempt as registry admission. */
export function readDirectAdmission(
  { candidate, registry, repository, tag, source, inputs },
  { run = command, now = new Date() } = {}
) {
  const directory = mkdtempSync(join(tmpdir(), 'openkit-direct-proof-'));
  try {
    run('gh', [
      'run',
      'download',
      String(candidate.runId),
      '--repo',
      repository,
      '--name',
      `direct-admission-${candidate.attempt}`,
      '--dir',
      directory,
    ]);
    const proof = readJson(join(directory, 'proof.json'));
    const { validUntil, checksums, inputs: provedInputs, qualification, ...scope } = proof;
    if (
      canonical(scope) !== canonical(candidateSecurityScope(registry)) ||
      scope.repository !== repository ||
      scope.tag !== tag ||
      scope.sha !== source ||
      provedInputs !== inputs ||
      !/^[a-f0-9]{64}$/u.test(checksums ?? '') ||
      !(now.getTime() < Date.parse(validUntil)) ||
      Date.parse(registry.checkedAt) < now.getTime() - maxAgeMs
    )
      throw Error('Exact current direct stable admission required');
    return { ...scope, validUntil, checksums, inputs: provedInputs, qualification };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Verify the complete latest attempt, then download only that run's release proof. */
function fetchProof({ repository, tag, source, directory, authorization }) {
  if (repository !== 'lingkaix/openkit' || commitAt('HEAD') !== source)
    throw Error('Unapproved publication repository or checkout');
  const grant = directStableGrant(tag, source, authorization);
  const images = catalog();
  const required = [
    ...candidateJobs,
    ...images.map((image) => `Candidate index (${image.id})`),
    ...directCandidateJobs,
  ];
  const observe = () =>
    observeRun({ repository, sha: source, runId: grant.runId, required, branch: 'main' });
  const candidate = observe();
  if (candidate.attempt !== grant.attempt) throw Error('Approved candidate attempt changed');
  command('gh', [
    'run',
    'download',
    String(grant.runId),
    '--repo',
    repository,
    '--name',
    `direct-release-${grant.attempt}`,
    '--dir',
    directory,
  ]);
  const proof = readJson(join(directory, 'proof.json'));
  const inputs = publicationInputsAt(process.cwd(), source).sha256;
  const registry = validateRegistryEvidence(readJson(join(directory, 'registry-admission.json')), {
    repository,
    source,
    tag,
    inputs,
    candidate,
    registry: candidate,
    images,
    notBefore: new Date(Date.now() - maxAgeMs).toISOString(),
    validUntil: proof.validUntil,
  });
  const { validUntil, checksums, inputs: provedInputs, qualification, ...scope } = proof;
  if (
    canonical(scope) !== canonical(candidateSecurityScope(registry)) ||
    provedInputs !== inputs ||
    checksums !== sha(readFileSync(join(directory, 'assets', 'SHA256SUMS'))) ||
    Date.now() >= Date.parse(validUntil)
  )
    throw Error('Exact current publication proof required');
  const assessment = tag === 'v0.2.0' ? readReleaseAssessment(process.cwd(), tag) : undefined;
  validateCandidateQualification(qualification, { tag, source, assessment });
  const { manifest } = releaseIntegritySubjects({
    repository,
    tag,
    sha: source,
    directory: join(directory, 'assets'),
    expectedSource: source,
  });
  for (const image of manifest.images) {
    const row = registry.images.find(({ candidate }) => candidate.id === image.id);
    const live = inspectReleaseImageState({
      versionTag: `${image.image}:${tag}`,
      versionWithoutVTag: `${image.image}:${tag.slice(1)}`,
      shaTag: `${image.image}:sha-${source.slice(0, 12)}`,
      latestTag: `${image.image}:latest`,
    });
    if (
      (live.present && (live.digest !== image.digest || live.latestBefore !== image.digest)) ||
      (!live.present && live.latestBefore !== row?.state.latestBefore)
    )
      throw Error('Immutable image or stable Latest state changed after candidate admission');
    const matching = row?.candidate;
    if (
      image.digest !== matching?.digest ||
      image.image !== matching.image ||
      image.platforms.some(
        ({ platform, digest }) =>
          !matching.platforms.some(
            (entry) => entry.platform === platform && entry.digest === digest
          )
      ) ||
      readFileSync(join(directory, 'security', `${image.id}.digest`), 'utf8').trim() !==
        image.digest
    )
      throw Error('Manifest and security admission image binding differ');
  }
  if (observe().attempt !== grant.attempt) throw Error('Approved candidate attempt changed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, tag, directory, registryFile, assetsDir] = process.argv.slice(2);
  const {
    GITHUB_REPOSITORY: repository,
    GITHUB_SHA: source,
    OPENKIT_STABLE_RELEASE: authorization,
  } = process.env;
  try {
    if (mode === 'scope')
      console.log(JSON.stringify(candidateSecurityScope(readJson(tag)), null, 2));
    else if (mode === 'build')
      await buildProof({ repository, tag, source, directory, registryFile, assetsDir });
    else if (mode === 'fetch') fetchProof({ repository, tag, source, directory, authorization });
    else if (mode === 'publish') {
      if (
        process.env.GITHUB_ACTIONS !== 'true' ||
        process.env.GITHUB_JOB !== 'github-release' ||
        process.env.GITHUB_EVENT_NAME !== 'push' ||
        process.env.GITHUB_REF !== `refs/tags/${tag}`
      )
        throw Error('Direct publication requires the authorized tag job');
      command(
        'gh',
        releaseCreateArgs({ repository, tag, assetsDir: directory, notesFile: registryFile })
      );
    } else throw Error('Direct release mode required');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
