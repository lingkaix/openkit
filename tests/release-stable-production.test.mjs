import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  applyStablePromotion,
  planStablePromotion,
  promotionAssets,
} from '../scripts/release-promotion.mjs';
import { createReleaseManifest } from '../scripts/release-record.mjs';

/**
 * Independent oracle for #225 production no-build stable promotion.
 *
 * Expected values come from docs/specs/20260829-release_management.md "Bounded
 * Synthetic Stable Rehearsal" and "Publication Authorization": a stable promotion
 * assigns the already published source indexes and copies the source attachments
 * unchanged, production admission needs the exact engineer prerequisite for the
 * exact tag and source commit, and the prerelease-only default still refuses.
 * Every negative case is paired with a positive that admits the unmutated
 * observation, so a refusal is attributable to the mutation.
 */

const catalog = JSON.parse(
  readFileSync(new URL('../containers/images.json', import.meta.url), 'utf8')
);
const releaseImageIds = catalog.images.filter((image) => image.release).map((image) => image.id);
const sha = 'a'.repeat(40);
const otherSha = 'e'.repeat(40);
const sourceRun = 7_100_042;
const requiredJobs = [
  'Publish app image',
  'Publish worker-common image',
  'Publish worker-runtimes image',
  'Publish GitHub Release',
  'Verify published release',
  'Smoke App native (linux/amd64)',
  'Smoke App native (linux/arm64)',
];
/** Every refusal in this module is prefixed with its owner name. */
const refusal = /Release Management/u;
const hex = (seed) => createHash('sha256').update(seed).digest('hex');
const indexDigest = (id) => `sha256:${hex(`index/${id}`)}`;

/**
 * Synthetic in-memory observation of one stable promotion input.
 * No network, registry, Git or GitHub effect is reachable from this shape.
 */
function observation({
  repository = 'lingkaix/openkit',
  tag = 'v0.1.0',
  sourceTag = `${tag}-rc.42`,
  authorization,
} = {}) {
  const owner = repository.split('/')[0];
  const images = releaseImageIds.map((id) => ({
    id,
    image: `ghcr.io/${owner}/openkit-${id}`,
    digest: indexDigest(id),
    prerelease: true,
    tags: [sourceTag, sourceTag.slice(1), `sha-${sha.slice(0, 12)}`],
    platforms: ['linux/amd64', 'linux/arm64'].map((platform) => ({
      platform,
      digest: `sha256:${hex(`${id}/${platform}`)}`,
    })),
  }));
  const assessment = {
    previousAppImageId: `sha256:${hex('previous-app-image')}`,
    migrationFree: true,
    configurationCompatible: true,
    retainedDataCompatible: true,
    recovery: 'previous-image-compatible',
    provenance: 'synthetic-stable-source',
  };
  const portable = promotionAssets(sourceTag).filter(
    (name) => name !== 'SHA256SUMS' && name !== `openkit-release-${sourceTag}.json`
  );
  const archiveChecksums = portable.map((name) => `${hex(`archive/${name}`)}  ${name}`).join('\n');
  const checksums = `${archiveChecksums}\n${hex('manifest')}  openkit-release-${sourceTag}.json\n`;
  const manifest = createReleaseManifest({
    repository,
    tag: sourceTag,
    sha,
    images,
    checksums: archiveChecksums,
    assertions: {
      ...assessment,
      sourceCommit: sha,
      appDigest: images.find((image) => image.id === 'app').digest,
    },
  });
  const reviewedNotes =
    '## Changes since the previous release\n\nSynthetic stable promotion.\n\n## Known issues\n\nR001 runtime qualification remains open.';
  return {
    repository,
    tag,
    sha,
    authorization,
    source: {
      tag: sourceTag,
      resolvedSha: sha,
      reviewedNotes,
      assessment,
      manifest,
      checksums,
      release: {
        tag_name: sourceTag,
        prerelease: true,
        draft: false,
        assets: promotionAssets(sourceTag).map((name) => ({ name })),
        body: `# OpenKit ${sourceTag}\n\n- Source commit: \`${sha}\`\n- Workflow run: https://github.com/${repository}/actions/runs/${sourceRun}\n\n${reviewedNotes}\n`,
      },
      run: {
        repository: { full_name: repository },
        id: sourceRun,
        run_attempt: 2,
        status: 'completed',
        conclusion: 'success',
        event: 'push',
        head_sha: sha,
        head_branch: sourceTag,
        path: '.github/workflows/ci.yml',
      },
      jobs: requiredJobs.map((name, index) => ({
        id: sourceRun * 10 + index + 1,
        name,
        conclusion: 'success',
        head_sha: sha,
        run_id: sourceRun,
        run_attempt: 2,
      })),
    },
    registry: manifest.images.map((image) => ({
      id: image.id,
      sourceTags: [image.digest, image.digest, image.digest],
      stableTags: ['', ''],
      latest: '',
      platforms: image.platforms,
    })),
  };
}

/** Authorized production observation: the exact engineer prerequisite. */
const production = (authorization = `v0.1.0@${sha}`) => observation({ authorization });

/** The complete immutable retry state: every stable identity already resolves to its source digest. */
function retryFixture() {
  const observation = production();
  const first = planStablePromotion(observation);
  completeStableIdentities(observation);
  observation.source.existingStableRelease = {
    id: 4_242,
    tag_name: observation.tag,
    name: observation.tag,
    draft: false,
    prerelease: false,
    body: first.body,
  };
  observation.source.latestReleaseId = 4_242;
  return { observation, first };
}

/** Rewrite every observed stable identity to the complete immutable set of its source digest. */
function completeStableIdentities(x) {
  for (const seen of x.registry) {
    const digest = x.source.manifest.images.find((image) => image.id === seen.id).digest;
    seen.stableTags = [digest, digest];
    seen.latest = digest;
  }
}

test('authorized production plan retains source commit, indexes and archives', () => {
  const x = production();
  const before = JSON.stringify(x);
  const plan = planStablePromotion(x);
  assert.equal(JSON.stringify(x), before, 'planning must stay a pure observation');
  assert.equal(plan.repository, 'lingkaix/openkit');
  assert.equal(plan.tag, 'v0.1.0');
  assert.equal(plan.sourceTag, 'v0.1.0-rc.42');
  assert.equal(plan.sha, sha);
  assert.equal(plan.mode, 'fresh');
  assert.equal(plan.releaseExists, false);
  assert.deepEqual(plan.images, x.source.manifest.images);
  for (const image of plan.images) {
    assert.equal(image.digest, indexDigest(image.id), `promoted index ${image.id}`);
    assert.deepEqual(
      image.platforms.map((platform) => platform.platform),
      ['linux/amd64', 'linux/arm64'],
      `complete platform set ${image.id}`
    );
  }
  assert.deepEqual(plan.assets, promotionAssets('v0.1.0-rc.42'));
  assert.ok(plan.assets.includes('openkit-ops-skill-v0.1.0-rc.42.tar.gz'));
  assert.ok(plan.body.includes('v0.1.0-rc.42'));
  assert.ok(plan.body.includes(`\`${sha}\``));
  assert.ok(plan.body.includes(x.source.reviewedNotes));
});

test('authorized production promotion assigns digests without rebuilding', async () => {
  const x = production();
  const plan = planStablePromotion(x);
  const writes = [];
  const digestByImage = new Map(plan.images.map((image) => [image.image, image.digest]));
  await applyStablePromotion(plan, {
    promote: async (image, digest, tags) => writes.push({ image, digest, tags }),
    resolve: async (reference) =>
      digestByImage.get(plan.images.find((i) => reference.startsWith(`${i.image}:`)).image),
    publish: async (published) => writes.push({ release: published.tag, assets: published.assets }),
  });
  const assignments = writes.filter((write) => write.release === undefined);
  assert.equal(assignments.length, plan.images.length, 'one tag assignment per source index');
  for (const write of assignments) {
    assert.equal(write.digest, digestByImage.get(write.image));
    assert.deepEqual(write.tags, ['v0.1.0', '0.1.0', 'latest']);
  }
  assert.equal(writes.length, assignments.length + 1);
  assert.equal(writes.at(-1).release, 'v0.1.0');
  assert.deepEqual(writes.at(-1).assets, promotionAssets('v0.1.0-rc.42'));
});

for (const [name, mutate] of [
  [
    'a missing engineer authorization',
    (x) => {
      x.authorization = undefined;
    },
  ],
  [
    'an empty engineer authorization',
    (x) => {
      x.authorization = '';
    },
  ],
  [
    'a non-string engineer authorization',
    (x) => {
      x.authorization = { tag: x.tag, sha };
    },
  ],
  [
    'an authorization for another stable version',
    (x) => {
      x.authorization = `v0.1.1@${sha}`;
    },
  ],
  [
    'an authorization for an earlier stable version',
    (x) => {
      x.authorization = `v0.0.9@${sha}`;
    },
  ],
  [
    'an authorization naming the source prerelease tag',
    (x) => {
      x.authorization = `${x.source.tag}@${sha}`;
    },
  ],
  [
    'an authorization for another source commit',
    (x) => {
      x.authorization = `${x.tag}@${otherSha}`;
    },
  ],
  [
    'an authorization carrying an extra field',
    (x) => {
      x.authorization = `${x.tag}@${sha}@signed`;
    },
  ],
])
  test(`production stable plan refuses ${name} before any effect`, () => {
    const x = production();
    mutate(x);
    assert.throws(() => planStablePromotion(x), refusal);
  });

for (const [name, mutate] of [
  [
    'an arbitrary repository',
    (x) => {
      x.repository = 'example/openkit';
    },
  ],
  [
    'a scratch-like repository without the bounded synthetic version',
    (x) => {
      x.repository = 'notrucked/other';
    },
  ],
  [
    'images owned by another repository owner',
    (x) => {
      for (const image of x.source.manifest.images)
        image.image = image.image.replace('ghcr.io/lingkaix/', 'ghcr.io/notrucked/');
    },
  ],
])
  test(`production stable plan refuses ${name}`, () => {
    const x = production();
    mutate(x);
    assert.throws(() => planStablePromotion(x), refusal);
  });

for (const [name, mutate] of [
  [
    'a source workflow without a run identity',
    (x) => {
      x.source.run.id = 'seven';
    },
  ],
  [
    'a failed source workflow',
    (x) => {
      x.source.run.conclusion = 'failure';
    },
  ],
  [
    'an incomplete source workflow',
    (x) => {
      x.source.run.status = 'in_progress';
    },
  ],
  [
    'a source workflow that is not a tag push',
    (x) => {
      x.source.run.event = 'workflow_dispatch';
    },
  ],
  [
    'a source workflow from another workflow path',
    (x) => {
      x.source.run.path = '.github/workflows/release-promotion.yml';
    },
  ],
  [
    'a source workflow from another repository',
    (x) => {
      x.source.run.repository.full_name = 'notrucked/openkit';
    },
  ],
  [
    'a source workflow on another commit',
    (x) => {
      x.source.run.head_sha = otherSha;
    },
  ],
  [
    'a source workflow on another tag',
    (x) => {
      x.source.run.head_branch = 'v0.1.0-rc.41';
    },
  ],
  [
    'a source workflow without a current attempt',
    (x) => {
      x.source.run.run_attempt = 0;
    },
  ],
  [
    'a failed required source job',
    (x) => {
      x.source.jobs.at(-1).conclusion = 'failure';
    },
  ],
  [
    'a skipped required source job',
    (x) => {
      x.source.jobs.at(-1).conclusion = 'skipped';
    },
  ],
  [
    'a cancelled required source job',
    (x) => {
      x.source.jobs[0].conclusion = 'cancelled';
    },
  ],
  [
    'a duplicate required source job',
    (x) => {
      x.source.jobs.push({ ...x.source.jobs[0], id: x.source.jobs[0].id + 900 });
    },
  ],
  [
    'a missing required source job',
    (x) => {
      x.source.jobs.splice(0, 1);
    },
  ],
  [
    'a source job without a run identity',
    (x) => {
      delete x.source.jobs[0].id;
    },
  ],
  [
    'a source job from a superseded attempt',
    (x) => {
      x.source.jobs[0].run_attempt = 1;
    },
  ],
  [
    'a source job from another run',
    (x) => {
      x.source.jobs[0].run_id = sourceRun + 1;
    },
  ],
  [
    'a source job on another commit',
    (x) => {
      x.source.jobs[0].head_sha = otherSha;
    },
  ],
  [
    'a draft source prerelease',
    (x) => {
      x.source.release.draft = true;
    },
  ],
  [
    'a source release that is already stable',
    (x) => {
      x.source.release.prerelease = false;
    },
  ],
  [
    'a source release naming another tag',
    (x) => {
      x.source.release.tag_name = 'v0.1.0-rc.41';
    },
  ],
  [
    'an incomplete source attachment set',
    (x) => {
      x.source.release.assets.pop();
    },
  ],
  [
    'a duplicate source attachment',
    (x) => {
      x.source.release.assets.push(x.source.release.assets[0]);
    },
  ],
  [
    'source notes without the exact source commit',
    (x) => {
      x.source.release.body = `# OpenKit ${x.source.tag}\n\n${x.source.reviewedNotes}\n`;
    },
  ],
  [
    'source notes that lost the reviewed known issues',
    (x) => {
      x.source.release.body = x.source.release.body.replace(x.source.reviewedNotes, '');
    },
  ],
  [
    'a source prerelease on another commit',
    (x) => {
      x.source.resolvedSha = otherSha;
    },
  ],
  [
    'a source prerelease of another stable version',
    (x) => {
      x.source.tag = 'v0.1.1-rc.42';
    },
  ],
  [
    'a source prerelease of another version family',
    (x) => {
      x.source.tag = 'v0.0.42-rc.42';
    },
  ],
  [
    'a source manifest bound to another commit',
    (x) => {
      x.source.manifest.sourceCommit = otherSha;
    },
  ],
  [
    'a source manifest without the reviewed recovery assertion',
    (x) => {
      x.source.assessment.recovery = 'unknown';
    },
  ],
  [
    'an empty registry observation',
    (x) => {
      x.registry = [];
    },
  ],
  [
    'a registry observation with a duplicate image',
    (x) => {
      x.registry[1].id = x.registry[0].id;
    },
  ],
  [
    'a source index whose immutable tags disagree',
    (x) => {
      x.registry[0].sourceTags[1] = `sha256:${'c'.repeat(64)}`;
    },
  ],
  [
    'a source index without all three immutable tags',
    (x) => {
      x.registry[0].sourceTags.pop();
    },
  ],
  [
    'a source index with a foreign platform digest set',
    (x) => {
      x.registry[0].platforms.pop();
    },
  ],
])
  test(`production stable plan refuses ${name}`, () => {
    const x = production();
    mutate(x);
    assert.throws(() => planStablePromotion(x), refusal);
  });

test('authorized production retry admits only the complete immutable identity set', async () => {
  const fixture = retryFixture();
  const x = fixture.observation;
  const retry = planStablePromotion(x);
  assert.equal(retry.mode, 'reuse');
  assert.equal(retry.releaseExists, true);
  assert.deepEqual(retry.images, fixture.first.images);
  const writes = [];
  const digestByImage = new Map(retry.images.map((image) => [image.image, image.digest]));
  await applyStablePromotion(retry, {
    promote: async (...value) => writes.push(value),
    resolve: async (reference) =>
      digestByImage.get(retry.images.find((i) => reference.startsWith(`${i.image}:`)).image),
    publish: async (...value) => writes.push(value),
  });
  assert.deepEqual(writes, [], 'a complete retry rewrites no image and no release');
});

for (const [name, mutate] of [
  [
    'a published stable release that is still a prerelease',
    (x) => {
      x.source.existingStableRelease.prerelease = true;
      return x;
    },
  ],
  [
    'GitHub Latest on another release',
    (x) => {
      x.source.latestReleaseId = 4_243;
      return x;
    },
  ],
])
  test(`authorized production retry refuses ${name} instead of repairing it`, () => {
    assert.throws(() => planStablePromotion(mutate(retryFixture().observation)), refusal);
  });

for (const [name, mutate] of [
  [
    'a partial stable tag set',
    (x) => {
      completeStableIdentities(x);
      x.registry[0].stableTags[0] = '';
    },
  ],
  [
    'a conflicting stable tag',
    (x) => {
      completeStableIdentities(x);
      x.registry[0].stableTags[1] = `sha256:${'c'.repeat(64)}`;
    },
  ],
  [
    'a diverging Latest pointer',
    (x) => {
      completeStableIdentities(x);
      x.registry[0].latest = `sha256:${'c'.repeat(64)}`;
    },
  ],
  [
    'a partial stable image matrix',
    (x) => {
      const digest = x.source.manifest.images[0].digest;
      x.registry[0].stableTags = [digest, digest];
      x.registry[0].latest = digest;
    },
  ],
  [
    'a published stable release without complete stable identities',
    (x) => {
      x.source.existingStableRelease = { id: 4_242, tag_name: x.tag, name: x.tag };
    },
  ],
  [
    'an existing stable release whose notes differ',
    (x) => {
      completeStableIdentities(x);
      x.source.existingStableRelease = {
        id: 4_242,
        tag_name: x.tag,
        name: x.tag,
        draft: false,
        prerelease: false,
        body: '# OpenKit v0.1.0\n\nRewritten notes.\n',
      };
      x.source.latestReleaseId = 4_242;
    },
  ],
])
  test(`production stable plan refuses ${name} instead of repairing it`, () => {
    const x = production();
    mutate(x);
    assert.throws(() => planStablePromotion(x), refusal);
  });

test('the bounded synthetic scratch rehearsal stays admitted without authorization', () => {
  const x = observation({
    repository: 'notrucked/openkit',
    tag: 'v0.0.42',
    sourceTag: 'v0.0.42-p15.1',
  });
  const plan = planStablePromotion(x);
  assert.equal(plan.repository, 'notrucked/openkit');
  assert.equal(plan.tag, 'v0.0.42');
  assert.equal(plan.sha, sha);
  assert.equal(plan.mode, 'fresh');
  assert.deepEqual(plan.images, x.source.manifest.images);
  assert.deepEqual(plan.assets, promotionAssets('v0.0.42-p15.1'));
});

for (const [name, build] of [
  [
    'a scratch stable version outside 0.0.x',
    () => observation({ repository: 'notrucked/openkit', tag: 'v0.2.0' }),
  ],
  [
    'a scratch stable version outside 0.0.x even with an authorization',
    () =>
      observation({
        repository: 'notrucked/openkit',
        tag: 'v0.2.0',
        authorization: `v0.2.0@${sha}`,
      }),
  ],
  [
    'another non-production repository naming a bounded synthetic version',
    () => observation({ repository: 'notrucked/fork', tag: 'v0.0.42' }),
  ],
  [
    'a production repository with a bounded synthetic version and no authorization',
    () => observation({ repository: 'lingkaix/openkit', tag: 'v0.0.16' }),
  ],
  [
    'a foreign repository with a production-shaped authorization',
    () =>
      observation({
        repository: 'example/openkit',
        tag: 'v0.1.0',
        authorization: `v0.1.0@${sha}`,
      }),
  ],
])
  test(`stable plan refuses ${name}`, () => {
    assert.throws(() => planStablePromotion(build()), refusal);
  });
