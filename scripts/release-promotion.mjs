#!/usr/bin/env node
/** No-build promotion of an already verified prerelease; live admission is scratch-only while R001 stays open. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { verifyOperationsSkillArchive } from './package-release-assets.mjs';
import { resolveImageDigest } from './release-image-state.mjs';
import { readReleaseNotesInput } from './release-notes.mjs';
import { parseVersionTag } from './release-preflight.mjs';
import {
  createReleaseManifest,
  publicationManifest,
  readReleaseAssessment,
} from './release-record.mjs';
import { verifyNanoHostRelease } from './verify-nanohost-release.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const requireFact = (value, message) => {
  if (!value) throw Error(`Release Management: stable promotion refused: ${message}`);
};
const requiredJobs = [
  'Publish app image',
  'Publish worker-common image',
  'Publish worker-runtimes image',
  'Publish GitHub Release',
  'Verify published release',
  'Smoke App native (linux/amd64)',
  'Smoke App native (linux/arm64)',
];

/** Names remain the source prerelease identities: renaming an inner archive would change its bytes. */
export function promotionAssets(sourceTag) {
  parseVersionTag(sourceTag);
  requireFact(sourceTag.includes('-'), 'source must be a prerelease');
  return [
    'SHA256SUMS',
    `openkit-ops-skill-${sourceTag}.tar.gz`,
    `openkit-nanohost-${sourceTag}-linux-amd64.tar.gz`,
    `openkit-nanohost-${sourceTag}-linux-arm64.tar.gz`,
    `openkit-release-${sourceTag}.json`,
  ].sort();
}

/** Validate observed source, successful latest-attempt proof, exact indexes and immutable retry state before writes. */
export function planStablePromotion({ repository, tag, sha, source, registry }) {
  const version = parseVersionTag(tag);
  requireFact(
    repository === 'notrucked/openkit' && /^0\.0\.(?:0|[1-9]\d*)$/.test(version),
    'only the bounded synthetic scratch stable rehearsal is admitted; production remains reserved'
  );
  requireFact(/^[a-f0-9]{40}$/.test(sha ?? ''), 'exact source commit');
  requireFact(
    source.tag.startsWith(`${tag}-`) && source.resolvedSha === sha,
    'same version and source commit'
  );
  const release = source.release;
  requireFact(
    release?.tag_name === source.tag && release.prerelease === true && release.draft === false,
    'published source prerelease'
  );
  requireFact(
    JSON.stringify(release.assets.map((a) => a.name).sort()) ===
      JSON.stringify(promotionAssets(source.tag)),
    'complete source attachments'
  );
  const run = source.run;
  requireFact(
    run?.status === 'completed' &&
      run.conclusion === 'success' &&
      run.event === 'push' &&
      run.repository?.full_name === repository &&
      run.head_sha === sha &&
      run.head_branch === source.tag &&
      run.path === '.github/workflows/ci.yml' &&
      Number.isSafeInteger(run.id) &&
      Number.isSafeInteger(run.run_attempt) &&
      run.run_attempt > 0,
    'successful exact-source tag workflow'
  );
  for (const name of requiredJobs) {
    const found = source.jobs.filter((j) => j.name === name);
    requireFact(
      found.length === 1 &&
        Number.isSafeInteger(found[0].id) &&
        found[0].id > 0 &&
        found[0].conclusion === 'success' &&
        found[0].head_sha === sha &&
        found[0].run_id === run.id &&
        found[0].run_attempt === run.run_attempt,
      `source job ${name}`
    );
  }
  requireFact(
    release.body.includes(`- Source commit: \`${sha}\``) &&
      release.body.includes(`/actions/runs/${run.id}`) &&
      release.body.includes(source.reviewedNotes),
    'reviewed prerelease notes and source run binding'
  );
  const m = source.manifest;
  const records = m.images.map((image) => ({
    ...image,
    prerelease: true,
    tags: [source.tag, source.tag.slice(1), `sha-${sha.slice(0, 12)}`],
  }));
  const archiveChecksums = source.checksums
    .split('\n')
    .filter((line) => line && !line.endsWith(`  openkit-release-${source.tag}.json`))
    .join('\n');
  const expected = createReleaseManifest({
    repository,
    tag: source.tag,
    sha,
    images: records,
    checksums: archiveChecksums,
    assertions: {
      ...source.assessment,
      sourceCommit: sha,
      appDigest: m.images.find((i) => i.id === 'app')?.digest,
    },
  });
  requireFact(
    JSON.stringify(m) === JSON.stringify(expected),
    'manifest source and reviewed compatibility facts'
  );
  requireFact(
    Array.isArray(registry) &&
      registry.length === m.images.length &&
      new Set(registry.map((i) => i.id)).size === m.images.length,
    'complete registry observation'
  );
  let present = 0;
  for (const image of m.images) {
    requireFact(
      image.image === `ghcr.io/notrucked/openkit-${image.id}`,
      'scratch-owned image names only'
    );
    const seen = registry.find((i) => i.id === image.id);
    requireFact(
      seen && seen.sourceTags.length === 3 && seen.sourceTags.every((d) => d === image.digest),
      `source immutable tags ${image.id}`
    );
    requireFact(
      JSON.stringify(seen.platforms) === JSON.stringify(image.platforms),
      `exact index platforms ${image.id}`
    );
    requireFact(seen.stableTags.length === 2, `stable tag observation ${image.id}`);
    if (seen.stableTags.every((d) => d === '')) continue;
    requireFact(
      seen.stableTags.every((d) => d === image.digest) && seen.latest === image.digest,
      `partial, conflicting or superseded stable identity ${image.id}`
    );
    present++;
  }
  requireFact(present === 0 || present === m.images.length, 'partial stable matrix');
  requireFact(
    !source.existingStableRelease || present === m.images.length,
    'published release without complete stable identities'
  );
  const body = `# OpenKit ${tag}\n\n- Promoted without rebuild from \`${source.tag}\` at \`${sha}\`.\n- Source publication: https://github.com/${repository}/actions/runs/${run.id}\n- Portable attachments and checksums retain their source prerelease names and bytes.\n\n${release.body.replace(/^# OpenKit [^\n]+\n\n/u, '')}`;
  if (source.existingStableRelease) {
    const existing = source.existingStableRelease;
    requireFact(
      existing.tag_name === tag &&
        existing.name === tag &&
        existing.draft === false &&
        existing.prerelease === false &&
        existing.body === body &&
        source.latestReleaseId === existing.id,
      'existing stable release or GitHub Latest differs'
    );
  }
  return {
    repository,
    tag,
    sha,
    sourceTag: source.tag,
    sourceRun: run.id,
    sourceAttempt: run.run_attempt,
    mode: present ? 'reuse' : 'fresh',
    releaseExists: Boolean(source.existingStableRelease),
    images: m.images,
    assets: promotionAssets(source.tag),
    body,
  };
}

/** Execute only tag assignment and release creation; a retry verifies every existing identity without rewriting it. */
export async function applyStablePromotion(plan, io) {
  if (plan.mode === 'fresh') {
    for (const image of plan.images) {
      await io.promote(image.image, image.digest, [plan.tag, plan.tag.slice(1), 'latest']);
    }
  }
  for (const image of plan.images) {
    for (const tag of [plan.tag, plan.tag.slice(1), `sha-${plan.sha.slice(0, 12)}`, 'latest'])
      requireFact(
        (await io.resolve(`${image.image}:${tag}`)) === image.digest,
        `promoted digest ${image.id}:${tag}`
      );
  }
  if (!plan.releaseExists) await io.publish(plan);
}

const run = (command, args) =>
  execFileSync(command, args, {
    encoding: 'utf8',
    timeout: 600000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const api = (endpoint, paginate = false) =>
  JSON.parse(run('gh', ['api', ...(paginate ? ['--paginate', '--slurp'] : []), endpoint]));

/** A lightweight or annotated remote tag must resolve to the exact checkout; API errors never mean absence. */
function resolveTag(repository, tag) {
  let value = api(`repos/${repository}/git/ref/tags/${tag}`).object;
  for (let i = 0; value.type === 'tag' && i < 8; i++)
    value = api(`repos/${repository}/git/tags/${value.sha}`).object;
  requireFact(value.type === 'commit', 'tag must resolve to a commit');
  return value.sha;
}

/** Verify exact source archives through the same contained download checks used by prerelease publication. */
function verifyArchives(repoRoot, dir, sourceTag) {
  verifyOperationsSkillArchive({
    archivePath: join(dir, `openkit-ops-skill-${sourceTag}.tar.gz`),
    destDir: join(dir, 'ops-extracted'),
    repoRoot,
  });
  for (const arch of ['amd64', 'arm64'])
    verifyNanoHostRelease({
      archive: join(dir, `openkit-nanohost-${sourceTag}-linux-${arch}.tar.gz`),
      checksumFile: join(dir, 'SHA256SUMS'),
      destdir: join(dir, `staged-${arch}`),
      repoRoot,
    });
}

/** Observe, admit, optionally promote, then download and verify again; no source or image construction is available. */
async function main() {
  const { values: args } = parseArgs({
    options: {
      repository: { type: 'string' },
      tag: { type: 'string' },
      sha: { type: 'string' },
      output: { type: 'string' },
      'check-only': { type: 'boolean', default: false },
    },
  });
  const { repository, tag, sha } = args;
  requireFact(repository === 'notrucked/openkit', 'production stable publication remains reserved');
  requireFact(run('git', ['rev-parse', 'HEAD']) === sha, 'clean exact-source checkout');
  requireFact(run('git', ['status', '--porcelain']) === '', 'clean exact-source checkout');
  requireFact(resolveTag(repository, tag) === sha, 'stable tag source');
  const dir = resolve(args.output);
  mkdirSync(dir, { recursive: false });
  const releases = api(`repos/${repository}/releases?per_page=100`, true).flat();
  const sources = releases.filter(
    (r) => r.prerelease && !r.draft && r.tag_name.startsWith(`${tag}-`)
  );
  requireFact(sources.length === 1, 'one published prerelease of this synthetic version');
  const sourceRelease = sources[0],
    sourceTag = sourceRelease.tag_name;
  const match = /\/actions\/runs\/(\d+)/u.exec(sourceRelease.body ?? '');
  requireFact(match, 'source publication run');
  const sourceRun = api(`repos/${repository}/actions/runs/${match[1]}`);
  const sourceJobs = api(
    `repos/${repository}/actions/runs/${sourceRun.id}/attempts/${sourceRun.run_attempt}/jobs?per_page=100`,
    true
  ).flatMap((p) => p.jobs);
  const sourceDir = join(dir, 'source');
  mkdirSync(sourceDir);
  run('gh', ['release', 'download', sourceTag, '--repo', repository, '--dir', sourceDir]);
  const manifest = JSON.parse(
    readFileSync(join(sourceDir, `openkit-release-${sourceTag}.json`), 'utf8')
  );
  const recordsDir = join(dir, 'records');
  mkdirSync(recordsDir);
  for (const image of manifest.images)
    writeFileSync(
      join(recordsDir, `${image.id}.json`),
      JSON.stringify({
        ...image,
        prerelease: true,
        tags: [sourceTag, sourceTag.slice(1), `sha-${sha.slice(0, 12)}`],
      })
    );
  publicationManifest({
    repoRoot: process.cwd(),
    tag: sourceTag,
    sha,
    repository,
    recordsDir,
    assetsDir: sourceDir,
    verify: true,
  });
  verifyArchives(process.cwd(), sourceDir, sourceTag);
  const registry = manifest.images.map((image) => {
    const index = JSON.parse(
      run('docker', ['buildx', 'imagetools', 'inspect', '--raw', `${image.image}@${image.digest}`])
    );
    const platforms = index.manifests
      .filter((m) => m.platform?.os !== 'unknown')
      .map((m) => ({ platform: `${m.platform.os}/${m.platform.architecture}`, digest: m.digest }))
      .sort((a, b) => a.platform.localeCompare(b.platform));
    return {
      id: image.id,
      platforms,
      sourceTags: [sourceTag, sourceTag.slice(1), `sha-${sha.slice(0, 12)}`].map((t) =>
        resolveImageDigest(`${image.image}:${t}`)
      ),
      stableTags: [tag, tag.slice(1)].map((t) => resolveImageDigest(`${image.image}:${t}`)),
      latest: resolveImageDigest(`${image.image}:latest`),
    };
  });
  const source = {
    tag: sourceTag,
    resolvedSha: resolveTag(repository, sourceTag),
    release: sourceRelease,
    run: sourceRun,
    jobs: sourceJobs,
    manifest,
    checksums: readFileSync(join(sourceDir, 'SHA256SUMS'), 'utf8'),
    assessment: readReleaseAssessment(process.cwd(), sourceTag),
    reviewedNotes: readReleaseNotesInput(process.cwd(), sourceTag),
    existingStableRelease: releases.find((r) => r.tag_name === tag),
    latestReleaseId: releases.some((r) => r.tag_name === tag)
      ? api(`repos/${repository}/releases/latest`).id
      : null,
  };
  const plan = planStablePromotion({ repository, tag, sha, source, registry });
  const currentRun = api(`repos/${repository}/actions/runs/${sourceRun.id}`);
  requireFact(
    currentRun.run_attempt === sourceRun.run_attempt && currentRun.conclusion === 'success',
    'source attempt changed'
  );
  requireFact(
    resolveTag(repository, tag) === sha && resolveTag(repository, sourceTag) === sha,
    'tag binding changed'
  );
  writeFileSync(join(dir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  if (args['check-only']) {
    console.log(`Stable promotion check passed (${plan.mode}); no writes.`);
    return;
  }
  requireFact(
    process.env.GITHUB_REPOSITORY === repository &&
      process.env.GITHUB_EVENT_NAME === 'push' &&
      process.env.GITHUB_REF === `refs/tags/${tag}` &&
      process.env.GITHUB_SHA === sha,
    'live promotion requires the exact scratch tag workflow'
  );
  const notes = join(dir, 'stable-notes.md');
  writeFileSync(notes, plan.body);
  await applyStablePromotion(plan, {
    promote: async (image, imageDigest, tags) =>
      run('docker', [
        'buildx',
        'imagetools',
        'create',
        ...tags.flatMap((t) => ['--tag', `${image}:${t}`]),
        `${image}@${imageDigest}`,
      ]),
    resolve: async (reference) => resolveImageDigest(reference),
    publish: async () => {
      run('gh', [
        'release',
        'create',
        tag,
        ...plan.assets.map((n) => join(sourceDir, n)),
        '--repo',
        repository,
        '--verify-tag',
        '--title',
        tag,
        '--notes-file',
        notes,
        '--latest',
      ]);
    },
  });
  const after = api(`repos/${repository}/releases/tags/${tag}`);
  requireFact(
    after.tag_name === tag &&
      after.name === tag &&
      !after.prerelease &&
      !after.draft &&
      after.body === plan.body,
    'stable release flags, title and reviewed notes'
  );
  requireFact(api(`repos/${repository}/releases/latest`).id === after.id, 'scratch GitHub Latest');
  requireFact(
    JSON.stringify(after.assets.map((a) => a.name).sort()) === JSON.stringify(plan.assets),
    'stable attachment set'
  );
  const downloaded = join(dir, 'downloaded');
  mkdirSync(downloaded);
  run('gh', ['release', 'download', tag, '--repo', repository, '--dir', downloaded]);
  for (const name of plan.assets)
    requireFact(
      readFileSync(join(sourceDir, name)).equals(readFileSync(join(downloaded, name))),
      `unchanged promoted attachment ${name}`
    );
  publicationManifest({
    repoRoot: process.cwd(),
    tag: sourceTag,
    sha,
    repository,
    recordsDir,
    assetsDir: downloaded,
    verify: true,
  });
  verifyArchives(process.cwd(), downloaded, sourceTag);
  run('docker', ['logout', 'ghcr.io']);
  const common = plan.images.find((i) => i.id === 'worker-common');
  requireFact(
    resolveImageDigest(`${common.image}@${common.digest}`) === common.digest,
    'anonymous worker-common digest'
  );
  writeFileSync(
    join(dir, 'verified.json'),
    `${JSON.stringify(
      {
        repository,
        tag,
        sha,
        sourceTag,
        sourceRun: sourceRun.id,
        sourceAttempt: sourceRun.run_attempt,
        mode: plan.mode,
        images: plan.images,
        assets: plan.assets.map((name) => ({
          name,
          sha256: digest(readFileSync(join(downloaded, name))),
        })),
        releaseUrl: after.html_url,
        observedAt: new Date().toISOString(),
        result: 'passed',
      },
      null,
      2
    )}\n`
  );
  console.log(
    `Stable promotion verified (${plan.mode}); source images and five attachments are unchanged.`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(
      error instanceof Error && error.message.startsWith('Release Management:')
        ? error.message
        : 'Release Management: stable promotion verification failed; inspect before retry.'
    );
    process.exitCode = 1;
  });
