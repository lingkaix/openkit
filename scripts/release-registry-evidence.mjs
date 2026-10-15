#!/usr/bin/env node
/** Keep registry authority in CI and transport only exact-source observations through repository artifacts. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { validateCandidate, verifyIndex } from './release-candidate.mjs';
import { inspectReleaseImageState, resolveImageDigest } from './release-image-state.mjs';
import { command, commitAt, githubJson, observeRun } from './release-observe.mjs';
import { candidateJobs, publicationInputsAt, registryJob } from './release-publication-check.mjs';
import { canonical, sha } from './release-safety.mjs';

/** Refuse absent, stale or mismatched evidence before it can admit a tag. */
export function validateRegistryEvidence(
  record,
  {
    repository,
    source,
    tag,
    inputs,
    candidate,
    registry,
    images,
    notBefore,
    validUntil,
    now = new Date(),
  }
) {
  const checked = Date.parse(record?.checkedAt);
  const started = Date.parse(record?.inspectionStartedAt);
  if (
    record?.schemaVersion !== 1 ||
    record.repository !== repository ||
    record.sha !== source ||
    record.tag !== tag ||
    record.inputs !== inputs ||
    record.provenance?.runId !== registry.runId ||
    record.provenance.attempt !== registry.attempt ||
    record.candidate?.runId !== candidate.runId ||
    record.candidate.attempt !== candidate.attempt ||
    !Number.isFinite(started) ||
    started < Date.parse(notBefore) ||
    started > checked ||
    !Number.isFinite(checked) ||
    checked < Date.parse(notBefore) ||
    checked > now.getTime() ||
    now.getTime() >= Date.parse(validUntil) ||
    !Number.isFinite(Date.parse(notBefore)) ||
    !Number.isFinite(Date.parse(validUntil)) ||
    !Array.isArray(record.images) ||
    images.length < 1 ||
    new Set(images.map((i) => i.id)).size !== images.length ||
    record.images.length !== images.length
  )
    throw Error('Current exact-P registry evidence required');
  for (const image of images) {
    const matches = record.images.filter((r) => r.candidate?.id === image.id);
    if (matches.length !== 1) throw Error('Complete unique registry image observations required');
    const entry = matches[0];
    const job = candidate.jobs.find((j) => j.name === `Candidate index (${image.id})`);
    validateCandidate(entry.candidate, {
      repository,
      sha: source,
      tag,
      inputs,
      proof: { runId: candidate.runId, attempt: candidate.attempt, jobId: job?.id },
      image,
    });
    verifyIndex(entry.candidate, entry.index);
    if (
      entry.inspectedDigest !== entry.candidate.digest ||
      typeof entry.state?.present !== 'boolean' ||
      (entry.state.present
        ? entry.state.digest !== entry.candidate.digest
        : entry.state.digest !== '') ||
      (entry.state.latestBefore !== '' &&
        !/^sha256:[a-f0-9]{64}$/.test(entry.state.latestBefore ?? ''))
    )
      throw Error('Conflicting immutable registry identity');
  }
  return record;
}

/** Download from one observed current attempt; no registry command or credential is needed here. */
export function readRegistryEvidence(
  {
    repository,
    source,
    tag,
    inputs,
    candidate,
    registryRunId = candidate.runId,
    images,
    notBefore,
    validUntil,
  },
  { run = command, observe = observeRun, read = githubJson, directory, now = new Date() } = {}
) {
  const registry = observe({
    repository,
    sha: source,
    runId: registryRunId,
    required: [registryJob],
  });
  const artifactMetadata = () => {
    const pages = read(
      `repos/${repository}/actions/runs/${registry.runId}/artifacts?per_page=100`,
      { paginate: true }
    );
    if (!Array.isArray(pages) || pages.some((p) => !Array.isArray(p.artifacts)))
      throw Error('Complete artifact pagination required');
    const artifacts = pages.flatMap((p) => p.artifacts);
    const matches = artifacts.filter((a) => a.name === `registry-admission-${registry.attempt}`);
    if (
      pages.some((p) => p.total_count !== artifacts.length) ||
      matches.length !== 1 ||
      !Number.isSafeInteger(matches[0].id) ||
      matches[0].id < 1 ||
      matches[0].expired !== false ||
      matches[0].workflow_run?.id !== registry.runId ||
      matches[0].workflow_run.head_sha !== source
    )
      throw Error('Unique current non-expired source artifact required');
    return matches[0].id;
  };
  const artifactId = artifactMetadata();
  const temporary = !directory;
  directory ??= mkdtempSync(join(tmpdir(), 'openkit-registry-evidence-'));
  if (!temporary) mkdirSync(directory, { mode: 0o700 });
  try {
    run('gh', [
      'run',
      'download',
      String(registry.runId),
      '--repo',
      repository,
      '--name',
      `registry-admission-${registry.attempt}`,
      '--dir',
      directory,
    ]);
    const record = JSON.parse(readFileSync(join(directory, 'registry-admission.json'), 'utf8'));
    validateRegistryEvidence(record, {
      repository,
      source,
      tag,
      inputs,
      candidate,
      registry,
      images,
      notBefore,
      validUntil,
      now,
    });
    const current = observe({
      repository,
      sha: source,
      runId: registry.runId,
      required: [registryJob],
    });
    if (canonical(current) !== canonical(registry) || artifactMetadata() !== artifactId)
      throw Error('Registry observation attempt changed');
    return {
      ...record,
      ...registry,
      artifactId,
      recordSha256: sha(readFileSync(join(directory, 'registry-admission.json'))),
      images: record.images,
    };
  } finally {
    if (temporary) rmSync(directory, { recursive: true, force: true });
  }
}

/** Observe completed candidate dependencies even while this same run is finishing its final read-only job. */
function producerCandidate(repository, source, runId, currentRun, currentAttempt, images) {
  const required = [...candidateJobs, ...images.map((i) => `Candidate index (${i.id})`)];
  if (runId !== currentRun) return observeRun({ repository, sha: source, runId, required });
  const metadata = githubJson(`repos/${repository}/actions/runs/${runId}`);
  const pages = githubJson(
    `repos/${repository}/actions/runs/${runId}/attempts/${currentAttempt}/jobs?per_page=100`,
    { paginate: true }
  );
  const jobs = pages.flatMap((p) => p.jobs);
  if (
    metadata.head_sha !== source ||
    metadata.run_attempt !== currentAttempt ||
    metadata.path !== '.github/workflows/ci.yml' ||
    metadata.repository.full_name !== repository ||
    !(
      (metadata.event === 'push' && metadata.head_branch === 'main') ||
      metadata.event === 'workflow_dispatch'
    ) ||
    pages.some((p) => p.total_count !== jobs.length) ||
    required.some((name) => {
      const matches = jobs.filter((j) => j.name === name);
      return (
        matches.length !== 1 ||
        matches[0].run_attempt !== currentAttempt ||
        matches[0].status !== 'completed' ||
        matches[0].conclusion !== 'success'
      );
    })
  )
    throw Error('Complete current candidate dependencies required');
  return { runId, attempt: currentAttempt, jobs };
}

/** Execute registry reads only in the reviewed CI job using its existing package-read authority. */
export function collectRegistryEvidence(
  { repository, source, tag, candidateRunId, directory },
  { run = command } = {}
) {
  if (
    process.env.GITHUB_REPOSITORY !== repository ||
    process.env.GITHUB_SHA !== source ||
    process.env.GITHUB_JOB !== 'candidate-registry' ||
    commitAt('HEAD') !== source
  )
    throw Error('Registry producer is limited to the exact-source CI job');
  const currentRun = Number(process.env.GITHUB_RUN_ID),
    currentAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  if (
    !Number.isSafeInteger(currentRun) ||
    currentRun < 1 ||
    !Number.isSafeInteger(currentAttempt) ||
    currentAttempt < 1
  )
    throw Error('CI run identity required');
  if (candidateRunId !== undefined && (!Number.isSafeInteger(candidateRunId) || candidateRunId < 1))
    throw Error('Positive explicit candidate run required');
  const images = JSON.parse(readFileSync('containers/images.json', 'utf8')).images.filter(
    (i) => i.release
  );
  const candidate = producerCandidate(
    repository,
    source,
    candidateRunId || currentRun,
    currentRun,
    currentAttempt,
    images
  );
  const inputs = publicationInputsAt(process.cwd(), source).sha256;
  const observations = [];
  const inspectionStartedAt = new Date().toISOString();
  mkdirSync(directory, { recursive: true });
  for (const image of images) {
    const dest = join(directory, image.id);
    run('gh', [
      'run',
      'download',
      String(candidate.runId),
      '--repo',
      repository,
      '--name',
      `candidate-${image.id}-${candidate.attempt}`,
      '--dir',
      dest,
    ]);
    const record = JSON.parse(readFileSync(join(dest, `${image.id}.json`), 'utf8'));
    const job = candidate.jobs.find((j) => j.name === `Candidate index (${image.id})`);
    validateCandidate(record, {
      repository,
      sha: source,
      tag,
      inputs,
      proof: { runId: candidate.runId, attempt: candidate.attempt, jobId: job.id },
      image,
    });
    const index = JSON.parse(
      run('docker', [
        'buildx',
        'imagetools',
        'inspect',
        '--raw',
        `${record.image}@${record.digest}`,
      ])
    );
    verifyIndex(record, index);
    const inspectedDigest = resolveImageDigest(`${record.image}@${record.digest}`);
    const state = inspectReleaseImageState({
      versionTag: `${record.image}:${tag}`,
      versionWithoutVTag: `${record.image}:${tag.slice(1)}`,
      shaTag: `${record.image}:sha-${source.slice(0, 12)}`,
      latestTag: `${record.image}:latest`,
    });
    observations.push({ candidate: record, index, inspectedDigest, state });
  }
  const record = {
    schemaVersion: 1,
    repository,
    sha: source,
    tag,
    inputs,
    provenance: { runId: currentRun, attempt: currentAttempt },
    candidate: { runId: candidate.runId, attempt: candidate.attempt },
    inspectionStartedAt,
    checkedAt: new Date().toISOString(),
    images: observations,
  };
  validateRegistryEvidence(record, {
    repository,
    source,
    tag,
    inputs,
    candidate,
    registry: { runId: currentRun, attempt: currentAttempt },
    images,
    notBefore: record.inspectionStartedAt,
    validUntil: new Date(Date.parse(record.checkedAt) + 1).toISOString(),
    now: new Date(record.checkedAt),
  });
  writeFileSync(
    join(directory, 'registry-admission.json'),
    `${JSON.stringify(record, null, 2)}\n`,
    { flag: 'wx' }
  );
  return record;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({
      options: {
        tag: { type: 'string' },
        'candidate-run': { type: 'string' },
        directory: { type: 'string' },
      },
    });
    if (!values.tag || !values.directory)
      throw Error('Explicit intended tag and output directory required');
    const record = collectRegistryEvidence({
      repository: process.env.GITHUB_REPOSITORY,
      source: process.env.GITHUB_SHA,
      tag: values.tag,
      candidateRunId: values['candidate-run'] ? Number(values['candidate-run']) : undefined,
      directory: values.directory,
    });
    console.log(
      JSON.stringify({ sha: record.sha, checkedAt: record.checkedAt, images: record.images.length })
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
