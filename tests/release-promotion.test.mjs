import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyStablePromotion,
  planStablePromotion,
  promotionAssets,
} from '../scripts/release-promotion.mjs';
import { createReleaseManifest } from '../scripts/release-record.mjs';

/** Public synthetic observations, with independent exact source and stable identity maps. */
function observed() {
  const sha = 'a'.repeat(40),
    d = `sha256:${'b'.repeat(64)}`,
    tag = 'v0.0.16',
    sourceTag = `${tag}-p15.1`;
  const images = ['app', 'worker-common', 'worker-runtimes'].map((id) => ({
    id,
    image: `ghcr.io/notrucked/openkit-${id}`,
    digest: d,
    prerelease: true,
    tags: [sourceTag, sourceTag.slice(1), `sha-${sha.slice(0, 12)}`],
    platforms: ['linux/amd64', 'linux/arm64'].map((platform) => ({ platform, digest: d })),
  }));
  const assessment = {
    previousAppImageId: `sha256:${'c'.repeat(64)}`,
    migrationFree: true,
    configurationCompatible: true,
    retainedDataCompatible: true,
    recovery: 'previous-image-compatible',
    provenance: 'synthetic-scratch-assessment',
  };
  const checksums = `${promotionAssets(sourceTag)
    .filter((n) => n !== 'SHA256SUMS' && n !== `openkit-release-${sourceTag}.json`)
    .map((n) => `${'d'.repeat(64)}  ${n}`)
    .join('\n')}\n`;
  const manifest = createReleaseManifest({
    repository: 'notrucked/openkit',
    tag: sourceTag,
    sha,
    images,
    checksums,
    assertions: { ...assessment, sourceCommit: sha, appDigest: d },
  });
  const reviewedNotes =
    '## Changes since the previous candidate\n\nSynthetic promotion.\n\n## Known issues\n\nR001 remains open; no product stable eligibility.';
  const jobs = [
    'Publish app image',
    'Publish worker-common image',
    'Publish worker-runtimes image',
    'Publish GitHub Release',
    'Verify published release',
    'Smoke App native (linux/amd64)',
    'Smoke App native (linux/arm64)',
  ].map((name, i) => ({
    id: i + 1,
    name,
    conclusion: 'success',
    head_sha: sha,
    run_id: 100,
    run_attempt: 1,
  }));
  return {
    repository: 'notrucked/openkit',
    tag,
    sha,
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
        body: `# OpenKit ${sourceTag}\n\n- Source commit: \`${sha}\`\n- Workflow run: https://github.com/notrucked/openkit/actions/runs/100\n\n${reviewedNotes}\n`,
      },
      run: {
        repository: { full_name: 'notrucked/openkit' },
        id: 100,
        run_attempt: 1,
        status: 'completed',
        conclusion: 'success',
        event: 'push',
        head_sha: sha,
        head_branch: sourceTag,
        path: '.github/workflows/ci.yml',
      },
      jobs,
    },
    registry: manifest.images.map((image) => ({
      id: image.id,
      sourceTags: [d, d, d],
      stableTags: ['', ''],
      latest: '',
      platforms: image.platforms,
    })),
  };
}

test('stable plan retains source assets, commit, indexes, reviewed notes and known limitations', () => {
  const x = observed(),
    plan = planStablePromotion(x);
  assert.equal(plan.sha, x.sha);
  assert.equal(plan.mode, 'fresh');
  assert.deepEqual(plan.images, x.source.manifest.images);
  assert.deepEqual(plan.assets, x.source.release.assets.map((a) => a.name).sort());
  assert.ok(plan.body.startsWith(`# OpenKit ${x.tag}\n`));
  assert.ok(plan.body.includes(x.source.reviewedNotes));
  assert.ok(plan.body.includes('R001 remains open'));
});

for (const [name, mutate] of [
  [
    'production',
    (x) => {
      x.repository = 'lingkaix/openkit';
    },
  ],
  [
    'non-synthetic stable',
    (x) => {
      x.tag = 'v0.1.0';
    },
  ],
  [
    'source commit',
    (x) => {
      x.source.resolvedSha = 'e'.repeat(40);
    },
  ],
  [
    'different source cycle',
    (x) => {
      x.source.tag = 'v0.0.17-p15.1';
    },
  ],
  [
    'draft source',
    (x) => {
      x.source.release.draft = true;
    },
  ],
  [
    'missing attachment',
    (x) => {
      x.source.release.assets.pop();
    },
  ],
  [
    'wrong source repository',
    (x) => {
      x.source.run.repository.full_name = 'other/openkit';
    },
  ],
  [
    'missing source job id',
    (x) => {
      delete x.source.jobs[0].id;
    },
  ],
  [
    'wrong workflow',
    (x) => {
      x.source.run.path = '.github/workflows/other.yml';
    },
  ],
  [
    'failed source workflow',
    (x) => {
      x.source.run.conclusion = 'failure';
    },
  ],
  [
    'source job attempt',
    (x) => {
      x.source.jobs[0].run_attempt++;
    },
  ],
  [
    'source job run',
    (x) => {
      x.source.jobs[0].run_id++;
    },
  ],
  [
    'source job SHA',
    (x) => {
      x.source.jobs[0].head_sha = 'e'.repeat(40);
    },
  ],
  [
    'duplicate source job',
    (x) => {
      x.source.jobs.push(x.source.jobs[0]);
    },
  ],
  [
    'missing native smoke',
    (x) => {
      x.source.jobs.pop();
    },
  ],
  [
    'skipped native smoke',
    (x) => {
      x.source.jobs.at(-1).conclusion = 'skipped';
    },
  ],
  [
    'dropped known issues',
    (x) => {
      x.source.release.body = 'unreviewed';
    },
  ],
  [
    'unknown assessment',
    (x) => {
      x.source.assessment.recovery = 'unknown';
    },
  ],
  [
    'unbound source manifest',
    (x) => {
      x.source.manifest.sourceCommit = 'e'.repeat(40);
    },
  ],
  [
    'source registry tag',
    (x) => {
      x.registry[0].sourceTags[0] = `sha256:${'e'.repeat(64)}`;
    },
  ],
  [
    'different platform',
    (x) => {
      x.registry[0].platforms = x.registry[0].platforms.slice(0, 1);
    },
  ],
  [
    'partial stable tags',
    (x) => {
      x.registry[0].stableTags[0] = x.source.manifest.images[0].digest;
    },
  ],
  [
    'partial stable matrix',
    (x) => {
      const d = x.source.manifest.images[0].digest;
      x.registry[0].stableTags = [d, d];
      x.registry[0].latest = d;
    },
  ],
  [
    'release without images',
    (x) => {
      x.source.existingStableRelease = {};
    },
  ],
])
  test(`stable plan refuses ${name} before writes`, () => {
    const x = observed();
    mutate(x);
    assert.throws(() => planStablePromotion(x), /stable promotion refused|manifest refused/);
  });

test('fresh promotion makes only tag assignments; retry makes none; no build or package adapter exists', async () => {
  const x = observed(),
    plan = planStablePromotion(x),
    writes = [];
  const io = {
    promote: async (...v) => writes.push(v),
    resolve: async () => plan.images[0].digest,
    publish: async (p) => writes.push(['release', p.tag]),
  };
  await applyStablePromotion(plan, io);
  assert.equal(writes.length, 4);
  assert.deepEqual(writes[0][2], [x.tag, x.tag.slice(1), 'latest']);
  for (const seen of x.registry) {
    seen.stableTags = [plan.images[0].digest, plan.images[0].digest];
    seen.latest = plan.images[0].digest;
  }
  x.source.existingStableRelease = {
    id: 200,
    tag_name: x.tag,
    name: x.tag,
    draft: false,
    prerelease: false,
    body: plan.body,
  };
  x.source.latestReleaseId = 200;
  const retry = planStablePromotion(x);
  assert.equal(retry.mode, 'reuse');
  writes.length = 0;
  await applyStablePromotion(retry, io);
  assert.deepEqual(writes, []);
  x.source.latestReleaseId = 201;
  assert.throws(() => planStablePromotion(x), /GitHub Latest differs/);
  x.source.latestReleaseId = 200;
  x.registry[1].latest = `sha256:${'f'.repeat(64)}`;
  assert.throws(() => planStablePromotion(x), /superseded stable identity/);
});

test('stable promotion retains the forward migration facts and rejects divergent ones', async () => {
  const x = observed();
  const before = x.source.manifest.assertions;
  x.source.assessment.migrationFree = false;
  x.source.assessment.recovery = 'restore-pre-update-backup';
  x.source.assessment.forwardMigration = {
    previousTag: 'v0.0.16-p14.1',
    ledgers: [{ ledger: 'drizzle.workspace', from: 1, to: 2 }],
    preUpdateBackupRequired: true,
    recoveryLimits: {
      workspaceOperationalBackup: 'creating-build-only',
      coldDataRootBackup: 'cross-release-forward-migration',
      rollback: 'restore-pre-update-backup-on-previous-build',
    },
  };
  x.source.manifest.assertions = {
    ...x.source.assessment,
    sourceCommit: before.sourceCommit,
    appDigest: before.appDigest,
  };
  const plan = planStablePromotion(x);
  const facts = x.source.assessment.forwardMigration;
  assert.deepEqual(plan.sourceFacts.assessment.forwardMigration, facts);
  assert.deepEqual(plan.sourceFacts.assertions.forwardMigration, facts);

  const effects = [];
  const io = {
    promote: async () => effects.push('promote'),
    resolve: async () => x.registry[0].sourceTags[0],
    publish: async () => effects.push('publish'),
  };
  await applyStablePromotion(plan, io);
  assert.deepEqual(effects, ['promote', 'promote', 'promote', 'publish']);
  effects.length = 0;
  plan.sourceFacts.assertions.forwardMigration.ledgers[0].to = 3;
  await assert.rejects(applyStablePromotion(plan, io), /assessed facts must match/);
  assert.deepEqual(effects, []);
});

test('a pre-stable reset prerelease is refused as a stable source before any plan or effect', async () => {
  for (const production of [false, true]) {
    const x = observed();
    if (production) {
      x.repository = 'lingkaix/openkit';
      x.authorization = `${x.tag}@${x.sha}`;
    }
    Object.assign(x.source.assessment, {
      migrationFree: false,
      configurationCompatible: false,
      retainedDataCompatible: false,
      recovery: 'pre-stable-reset',
    });
    x.source.manifest = createReleaseManifest({
      repository: x.repository,
      tag: x.source.tag,
      sha: x.sha,
      images: x.source.manifest.images.map((image) => ({
        ...image,
        prerelease: true,
        tags: [x.source.tag, x.source.tag.slice(1), `sha-${x.sha.slice(0, 12)}`],
      })),
      checksums: x.source.checksums,
      assertions: {
        ...x.source.assessment,
        sourceCommit: x.sha,
        appDigest: x.source.manifest.images[0].digest,
      },
    });
    assert.throws(() => planStablePromotion(x), /not a pre-stable reset/);
  }
  const mixed = observed();
  mixed.source.manifest = {
    ...mixed.source.manifest,
    assertions: { ...mixed.source.manifest.assertions, retainedDataCompatible: false },
  };
  assert.throws(() => planStablePromotion(mixed), /not a pre-stable reset/);
});

test('applying a plan without admitted compatible source facts makes no effect', async () => {
  const plan = planStablePromotion(observed());
  const effects = [];
  const io = {
    promote: async () => effects.push('promote'),
    resolve: async () => effects.push('resolve'),
    publish: async () => effects.push('publish'),
  };
  const { sourceFacts: _facts, ...withoutFacts } = plan;
  await assert.rejects(applyStablePromotion(withoutFacts, io), /not a pre-stable reset/);
  for (const side of ['assessment', 'assertions']) {
    const reset = structuredClone(plan);
    reset.sourceFacts[side].recovery = 'pre-stable-reset';
    await assert.rejects(applyStablePromotion(reset, io), /not a pre-stable reset/);
  }
  assert.deepEqual(effects, []);
});

test('post-assignment mismatch stops before GitHub Release creation', async () => {
  const plan = planStablePromotion(observed());
  let releases = 0;
  await assert.rejects(
    applyStablePromotion(plan, {
      promote: async () => {},
      resolve: async () => `sha256:${'f'.repeat(64)}`,
      publish: async () => releases++,
    }),
    /promoted digest/
  );
  assert.equal(releases, 0);
});
