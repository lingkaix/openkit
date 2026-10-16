#!/usr/bin/env node
/** Build evidence for digest-only prerelease candidates and refuse promotion across source identities. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { findReusableJob } from './release-ci-reuse.mjs';
import { parseReleaseNotesInput } from './release-notes.mjs';
import { publicationInputsAt } from './release-publication-check.mjs';

const digestPattern = /^sha256:[a-f0-9]{64}$/;
/** Refuse before a candidate can influence a release identity. */
function requireFact(value, message) {
  if (!value) throw Error(`Candidate refused: ${message}`);
}

/** Check the complete source, provenance, metadata and exact-digest smoke binding. */
export function validateCandidate(record, { repository, sha, tag, inputs, proof, image }) {
  const coordinate = `ghcr.io/${repository.split('/')[0].toLowerCase()}/${image.repository}`;
  requireFact(record?.schemaVersion === 1 && record.repository === repository, 'repository');
  requireFact(/^[a-f0-9]{40}$/.test(sha) && record.sha === sha, 'exact P');
  requireFact(
    /^v\d+\.\d+\.\d+-[a-z0-9][a-z0-9.-]*$/.test(tag) && record.tag === tag,
    'intended prerelease'
  );
  requireFact(/^[a-f0-9]{64}$/.test(inputs) && record.inputs === inputs, 'proved inputs');
  requireFact(
    proof &&
      Number.isSafeInteger(proof.jobId) &&
      proof.jobId > 0 &&
      Number.isSafeInteger(proof.runId) &&
      proof.runId > 0 &&
      Number.isSafeInteger(proof.attempt) &&
      proof.attempt > 0 &&
      record.provenance?.runId === proof.runId &&
      record.provenance.attempt === proof.attempt,
    'run/latest-attempt provenance'
  );
  requireFact(
    record.id === image.id &&
      record.image === coordinate &&
      digestPattern.test(record.digest ?? ''),
    'image identity'
  );
  requireFact(
    Array.isArray(record.platforms) &&
      record.platforms.length === image.platforms.length &&
      new Set(image.platforms).size === image.platforms.length,
    'complete platform set'
  );
  for (const platform of image.platforms) {
    const matches = record.platforms.filter((p) => p.platform === platform);
    requireFact(matches.length === 1, 'unique platform');
    const entry = matches[0];
    validatePlatform(entry, { repository, sha, tag, image });
  }
  return record;
}

/** Apply the same immutable platform identity rules before index construction and before promotion. */
function validatePlatform(entry, { repository, sha, tag, image }) {
  requireFact(digestPattern.test(entry.digest ?? ''), 'platform digest');
  requireFact(
    entry.labels?.['org.opencontainers.image.source'] === `https://github.com/${repository}` &&
      entry.labels['org.opencontainers.image.revision'] === sha &&
      entry.labels['org.opencontainers.image.version'] === tag.slice(1),
    'OCI source/revision/version'
  );
  requireFact(
    entry.smoke?.sha === sha &&
      entry.smoke.digest === entry.digest &&
      entry.smoke.conclusion === 'success',
    'exact-P digest smoke'
  );
  if (image.kind === 'app')
    requireFact(
      entry.appIdentity?.releaseTag === tag && entry.appIdentity.sourceCommit === sha,
      'App identity'
    );
}

/** Capture only non-secret program output; transport errors never print command environments. */
function run(executable, args, { env = process.env } = {}) {
  try {
    return execFileSync(executable, args, {
      encoding: 'utf8',
      timeout: 600000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    }).trim();
  } catch {
    throw Error(`Candidate operation failed: ${executable}`);
  }
}

/** Read the existing catalog; no second image or platform owner exists. */
function catalog() {
  return JSON.parse(readFileSync('containers/images.json', 'utf8')).images.filter((i) => i.release);
}

/** Require the checked-out immutable source and return its publication input closure. */
function source() {
  const repository = process.env.GITHUB_REPOSITORY;
  const sha = process.env.GITHUB_SHA;
  requireFact(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? ''), 'source repository');
  requireFact(run('git', ['rev-parse', 'HEAD']) === sha, 'checkout differs from P');
  return { repository, sha, inputs: publicationInputsAt(process.cwd(), sha).sha256 };
}

/** Emit bounded Actions outputs without evaluating the supplied values as shell text. */
function output(values) {
  for (const [key, value] of Object.entries(values)) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text.includes('\n')) console.log(`${key}<<OPENKIT_OUTPUT\n${text}\nOPENKIT_OUTPUT`);
    else console.log(`${key}=${text}`);
  }
}

/** Resolve the intended tag from an explicit dispatch or the single committed untagged notes input. */
export function selectTag({ explicit = '', notes, tags }) {
  const candidates = notes.filter(
    (n) => /^v\d+\.\d+\.\d+-[a-z0-9][a-z0-9.-]*$/.test(n) && !tags.includes(n)
  );
  if (explicit) {
    requireFact(candidates.includes(explicit), 'intended tag needs committed unused notes');
    return explicit;
  }
  requireFact(candidates.length <= 1, 'ambiguous intended prerelease');
  return candidates[0] ?? '';
}

/** Derive every native platform build once and retain the existing Worker smoke job identities. */
export function candidateMatrix(images) {
  return {
    include: images.flatMap((i) =>
      i.platforms.map((platform) => ({
        ...i,
        platform,
        architecture: platform.split('/')[1],
        runner: platform === 'linux/arm64' ? 'ubuntu-24.04-arm' : 'ubuntu-24.04',
        jobName:
          i.kind === 'worker'
            ? `Smoke ${i.id} (${platform})`
            : `Candidate image (${i.id}, ${platform})`,
      }))
    ),
  };
}

/** Preserve all existing release OCI labels and deterministic App build arguments. */
export function imageIdentity({ repository, sha, tag, created, image }) {
  requireFact(/^v\d+\.\d+\.\d+-[a-z0-9][a-z0-9.-]*$/.test(tag), 'prerelease identity');
  const labels = [
    `org.opencontainers.image.title=${image.repository}`,
    `org.opencontainers.image.description=OpenKit ${image.id} release image`,
    `org.opencontainers.image.source=https://github.com/${repository}`,
    `org.opencontainers.image.revision=${sha}`,
    `org.opencontainers.image.version=${tag.slice(1)}`,
    `org.opencontainers.image.created=${created}`,
    'org.opencontainers.image.licenses=Apache-2.0',
    `org.openkit.image.id=${image.id}`,
    `org.openkit.image.kind=${image.kind}`,
  ];
  if (image.runtimes?.length)
    labels.push(`org.openkit.worker.runtimes=${image.runtimes.join(',')}`);
  if (image.workerContract) labels.push(`org.openkit.worker.contract=${image.workerContract}`);
  return {
    image: `ghcr.io/${repository.split('/')[0].toLowerCase()}/${image.repository}`,
    labels: labels.join('\n'),
    args: image.kind === 'app' ? `OPENKIT_RELEASE_TAG=${tag}\nOPENKIT_SOURCE_COMMIT=${sha}` : '',
  };
}

/** Registry observations bind the candidate index to precisely the recorded platform manifests. */
export function verifyIndex(record, index) {
  requireFact(
    Array.isArray(index?.manifests) && index.manifests.length === record.platforms.length,
    'index platform set'
  );
  for (const p of record.platforms)
    requireFact(
      index.manifests.filter(
        (m) =>
          `${m.platform?.os}/${m.platform?.architecture}` === p.platform && m.digest === p.digest
      ).length === 1,
      'index/platform digest equality'
    );
}

/** Keep pre-tag registry references outside every public release identity namespace. */
export function candidateReference({ image, sha, runId, attempt }) {
  requireFact(
    /^ghcr\.io\/[a-z0-9._/-]+$/.test(image) &&
      /^[a-f0-9]{40}$/.test(sha) &&
      Number.isSafeInteger(runId) &&
      runId > 0 &&
      Number.isSafeInteger(attempt) &&
      attempt > 0,
    'candidate-only reference'
  );
  return `${image}:candidate-${sha}-${runId}-${attempt}`;
}

/** Run exact registry bytes, then record metadata and the App identity from that same immutable image. */
function smokePlatform({ image, digest, platform, definition }) {
  requireFact(digestPattern.test(digest), 'built platform digest');
  const reference = `${image}@${digest}`;
  run('docker', ['pull', '--platform', platform, reference]);
  // The catalog smoke owner also proves network-free Worker-base derivation; do not replace it with only the installed smoke command.
  run('bash', ['scripts/docker/smoke-image.sh', definition.id, reference], {
    env: { ...process.env, DOCKER_DEFAULT_PLATFORM: platform },
  });
  const observed = JSON.parse(run('docker', ['image', 'inspect', reference]))[0];
  const result = {
    platform,
    digest,
    labels: observed.Config.Labels,
    smoke: { sha: process.env.GITHUB_SHA, digest, conclusion: 'success' },
  };
  if (definition.kind === 'app')
    result.appIdentity = JSON.parse(
      run('docker', [
        'run',
        '--rm',
        '--platform',
        platform,
        '--entrypoint',
        'cat',
        reference,
        '/usr/local/lib/openkit/release-identity.json',
      ])
    );
  return result;
}

/** Read only GitHub's fixed API origin with the existing job-scoped token. */
function request(url) {
  requireFact(
    new URL(url).origin === 'https://api.github.com' && process.env.GITHUB_TOKEN,
    'API authority'
  );
  return fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': '2026-03-10',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
}

/** Fetch one successful exact-P index artifact and recheck the current completed run attempt. */
async function fetchCandidate({ identity, tag, image, directory }) {
  const proof = await findReusableJob(
    {
      repository: identity.repository,
      workflow: 'ci.yml',
      sha: identity.sha,
      jobName: `Candidate index (${image.id})`,
    },
    request
  );
  requireFact(proof, 'successful candidate index job unavailable');
  const runUrl = `https://api.github.com/repos/${identity.repository}/actions/runs/${proof.runId}`;
  const inspectRun = async () => {
    const response = await request(runUrl);
    requireFact(response.ok, 'candidate run observation');
    const run = await response.json();
    requireFact(
      run.head_sha === identity.sha &&
        run.run_attempt === proof.attempt &&
        run.status === 'completed' &&
        run.conclusion === 'success',
      'successful current candidate run'
    );
  };
  await inspectRun();
  mkdirSync(directory, { recursive: true });
  run('gh', [
    'run',
    'download',
    String(proof.runId),
    '--repo',
    identity.repository,
    '--name',
    `candidate-${image.id}-${proof.attempt}`,
    '--dir',
    directory,
  ]);
  const record = JSON.parse(readFileSync(join(directory, `${image.id}.json`), 'utf8'));
  validateCandidate(record, { ...identity, tag, proof, image });
  verifyIndex(
    record,
    JSON.parse(
      run('docker', [
        'buildx',
        'imagetools',
        'inspect',
        '--raw',
        `${record.image}@${record.digest}`,
      ])
    )
  );
  await inspectRun();
  return { record, proof };
}

/** Operate only candidate build evidence; release-tag mutation stays in the existing promotion step. */
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      id: { type: 'string' },
      tag: { type: 'string' },
      platform: { type: 'string' },
      digest: { type: 'string' },
      directory: { type: 'string' },
    },
  });
  const action = positionals[0];
  const images = catalog();
  if (action === 'select') {
    const tag = selectTag({
      explicit: values.tag,
      notes: readdirSync('release-notes')
        .filter((n) => n.endsWith('.md'))
        .map((n) => n.slice(0, -3)),
      tags: run('git', ['tag', '--list']).split('\n'),
    });
    if (tag) parseReleaseNotesInput(readFileSync(`release-notes/${tag}.md`, 'utf8'));
    output({
      enabled: String(Boolean(tag)),
      tag,
      matrix: candidateMatrix(images),
    });
    return;
  }
  const identity = source();
  const image = images.find((i) => i.id === values.id);
  requireFact(image && values.tag, 'catalog image and intended tag');
  if (action === 'identity') {
    output(
      imageIdentity({
        ...identity,
        tag: values.tag,
        image,
        created: run('git', ['show', '-s', '--format=%cI', identity.sha]),
      })
    );
  } else if (action === 'platform') {
    requireFact(image.platforms.includes(values.platform), 'catalog platform');
    const metadata = imageIdentity({ ...identity, tag: values.tag, image, created: '' });
    const platform = smokePlatform({
      image: metadata.image,
      digest: values.digest,
      platform: values.platform,
      definition: image,
    });
    const record = {
      ...identity,
      tag: values.tag,
      id: image.id,
      provenance: {
        runId: Number(process.env.GITHUB_RUN_ID),
        attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      },
      ...platform,
    };
    mkdirSync(values.directory, { recursive: true });
    writeFileSync(
      join(values.directory, `${image.id}-${values.platform.split('/')[1]}.json`),
      JSON.stringify(record)
    );
  } else if (action === 'index') {
    const records = readdirSync(values.directory)
      .filter((n) => n.startsWith(`${image.id}-`) && n.endsWith('.json'))
      .map((n) => JSON.parse(readFileSync(join(values.directory, n), 'utf8')));
    requireFact(records.length === image.platforms.length, 'complete platform records');
    for (const r of records)
      requireFact(
        r.repository === identity.repository &&
          r.sha === identity.sha &&
          r.tag === values.tag &&
          r.inputs === identity.inputs &&
          r.provenance.runId === Number(process.env.GITHUB_RUN_ID) &&
          r.provenance.attempt === Number(process.env.GITHUB_RUN_ATTEMPT),
        'platform provenance'
      );
    const platforms = image.platforms.map((platform) => {
      const matches = records.filter((r) => r.platform === platform);
      requireFact(matches.length === 1, 'unique catalog platform');
      validatePlatform(matches[0], { ...identity, tag: values.tag, image });
      const { digest, labels, smoke, appIdentity } = matches[0];
      return { platform, digest, labels, smoke, ...(appIdentity ? { appIdentity } : {}) };
    });
    const coordinate = imageIdentity({ ...identity, tag: values.tag, image, created: '' }).image;
    const candidate = candidateReference({
      image: coordinate,
      sha: identity.sha,
      runId: Number(process.env.GITHUB_RUN_ID),
      attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    });
    // Only the index has a candidate-only reference. Platform builds push by digest; no release identity moves.
    run('docker', [
      'buildx',
      'imagetools',
      'create',
      '--tag',
      candidate,
      ...platforms.map((r) => `${coordinate}@${r.digest}`),
    ]);
    const digest = run('docker', [
      'buildx',
      'imagetools',
      'inspect',
      '--format',
      '{{.Manifest.Digest}}',
      candidate,
    ]);
    requireFact(digestPattern.test(digest), 'candidate index digest');
    const record = {
      schemaVersion: 1,
      ...identity,
      tag: values.tag,
      id: image.id,
      image: coordinate,
      digest,
      provenance: records[0].provenance,
      platforms,
    };
    verifyIndex(
      record,
      JSON.parse(
        run('docker', ['buildx', 'imagetools', 'inspect', '--raw', `${coordinate}@${digest}`])
      )
    );
    writeFileSync(join(values.directory, `${image.id}.json`), JSON.stringify(record));
  } else if (action === 'fetch') {
    const { record, proof } = await fetchCandidate({
      identity,
      tag: values.tag,
      image,
      directory: values.directory,
    });
    output({ digest: record.digest, proof, record: join(values.directory, `${image.id}.json`) });
  } else
    throw Error(
      'Usage: release-candidate.mjs select|identity|platform|index|fetch with explicit inputs'
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
