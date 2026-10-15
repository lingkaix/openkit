import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { candidateMatrix } from '../scripts/release-candidate.mjs';

const workflowBytes = readFileSync(join(process.cwd(), '.github', 'workflows', 'ci.yml'), 'utf8');
const workflow = parse(workflowBytes);

test('test image jobs reap orphaned processes through Docker init', () => {
  const jobs = Object.entries(workflow.jobs).filter(
    ([, job]) => job.container?.image === actionExpression('needs.test-image.outputs.image')
  );
  assert.equal(jobs.length, 9);
  for (const [name, job] of jobs) {
    assert.equal(job.container.options, '--init', `${name} must reap orphaned processes`);
  }
});

test('release workflow serializes tag releases and pins third-party actions', () => {
  assert.deepEqual(workflow.on.push.tags, ['v*.*.*']);
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.match(workflow.concurrency.group, /openkit-release/);

  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      if (step.uses) {
        assert.match(
          step.uses,
          /^[^@]+@[a-f0-9]{40}$/,
          `${step.name} must use an immutable action ref`
        );
      }
    }
  }
});

test('release identity build arguments belong only to candidate App builds', () => {
  const job = workflow.jobs['candidate-images'];
  const identity = step(job, 'Compute the exact-P intended image identity');
  const candidate = step(job, 'Build one native digest-only candidate');
  const workerBuild = step(workflow.jobs['smoke-worker-images'], 'Build worker image');
  assert.match(identity.run, /release-candidate\.mjs identity/u);
  assert.equal(identity.env.CANDIDATE_TAG, actionExpression('needs.candidate-plan.outputs.tag'));
  assert.equal(candidate.with['build-args'], actionExpression('steps.image.outputs.args'));
  assert.equal(workerBuild.with['build-args'], undefined);
  assert.ok(job.steps.indexOf(identity) < job.steps.indexOf(candidate));
  assert.ok(
    !workflow.jobs['publish-container-images'].steps.some((s) =>
      s.uses?.startsWith('docker/build-push-action@')
    )
  );
});

test('tag publication promotes the proved candidate digest without rebuilding or moving Latest early', () => {
  const job = workflow.jobs['publish-container-images'];
  const existing = step(job, 'Inspect existing immutable identity');
  const candidateJob = workflow.jobs['candidate-images'];
  const candidate = step(candidateJob, 'Build one native digest-only candidate');
  const smoke = step(candidateJob, 'Smoke and record the exact registry platform digest');
  const resolve = step(job, 'Resolve the proved exact-P candidate digest');
  const promote = step(job, 'Promote the smoked digest');
  const verify = step(job, 'Verify promoted identity');
  const anonymous = step(job, 'Verify public worker base anonymous pull');
  const record = step(job, 'Write image release record');
  assert.equal(candidate.with.provenance, false);
  assert.match(candidate.with.outputs, /push-by-digest=true/);
  assert.equal(candidate.with.tags, undefined);
  assert.match(candidateJob.if, /needs\.candidate-plan\.outputs\.enabled == 'true'/u);
  assert.deepEqual(smoke.env, {
    IMAGE_ID: actionExpression('matrix.id'),
    CANDIDATE_TAG: actionExpression('needs.candidate-plan.outputs.tag'),
    PLATFORM: actionExpression('matrix.platform'),
    DIGEST: actionExpression('steps.candidate.outputs.digest'),
  });
  assert.match(smoke.run, /release-candidate\.mjs platform/u);
  assert.ok(candidateJob.steps.indexOf(candidate) < candidateJob.steps.indexOf(smoke));
  assert.match(resolve.run, /release-candidate\.mjs fetch/u);
  assert.match(resolve.run, /PRESENT.*true/u);
  assert.match(resolve.run, /digest=\$\{EXISTING_DIGEST\}/u);
  assert.ok(job.steps.indexOf(existing) < job.steps.indexOf(resolve));
  assert.ok(job.steps.indexOf(resolve) < job.steps.indexOf(promote));
  assert.equal(promote.if, "steps.existing.outputs.present == 'false'");
  assert.equal(promote.env.DIGEST, actionExpression('steps.release.outputs.digest'));
  assert.equal(promote.env.IMAGE, actionExpression('steps.image.outputs.image'));
  assert.equal(verify.env.DIGEST, actionExpression('steps.release.outputs.digest'));
  assert.equal(verify.env.LATEST_BEFORE, actionExpression('steps.existing.outputs.latest_before'));
  assert.deepEqual(existing.env, {
    LATEST_TAG: actionExpression('steps.image.outputs.latest_tag'),
    SHA_TAG: actionExpression('steps.image.outputs.sha_tag'),
    VERSION_TAG: actionExpression('steps.image.outputs.version_tag'),
    VERSION_WITHOUT_V_TAG: actionExpression('steps.image.outputs.version_without_v_tag'),
  });
  assert.ok(job.steps.indexOf(promote) < job.steps.indexOf(verify));
  assert.equal(anonymous.if, 'matrix.anonymousPull');
  assert.deepEqual(anonymous.env, {
    DIGEST: actionExpression('steps.release.outputs.digest'),
    IMAGE: actionExpression('steps.image.outputs.image'),
  });
  assert.ok(job.steps.indexOf(verify) < job.steps.indexOf(anonymous));
  assert.equal(record.env.ANONYMOUS_PULL, actionExpression('matrix.anonymousPull'));
  assert.match(promote.run, /imagetools create.*\$\{IMAGE\}@\$\{DIGEST\}/u);
});

test('candidate matrix smokes each catalog platform exactly once on a native runner', () => {
  const catalog = JSON.parse(readFileSync('containers/images.json', 'utf8')).images.filter(
    (i) => i.release
  );
  const matrix = candidateMatrix(catalog);
  const expected = catalog.flatMap((i) => i.platforms.map((p) => `${i.id}:${p}`)).sort();
  assert.deepEqual(matrix.include.map((i) => `${i.id}:${i.platform}`).sort(), expected);
  assert.equal(new Set(matrix.include.map((i) => i.jobName)).size, expected.length);
  for (const i of matrix.include)
    assert.equal(i.runner, i.platform === 'linux/arm64' ? 'ubuntu-24.04-arm' : 'ubuntu-24.04');
  assert.equal(workflow.jobs['candidate-images']['runs-on'], actionExpression('matrix.runner'));
});

test('any candidate platform failure prevents index assembly and tag promotion has no rebuild fallback', () => {
  const job = workflow.jobs['candidate-index'];
  assert.equal(workflow.jobs['candidate-images'].strategy['fail-fast'], false);
  assert.deepEqual(job.needs, ['candidate-plan', 'candidate-images', 'container-image-matrix']);
  assert.doesNotMatch(job.if, /always\(\)|failure\(\)/u);
  assert.equal(
    step(job, "Download this attempt's platform observations").with.pattern,
    'candidate-platform-$' + '{{ matrix.id }}-*-$' + '{{ github.run_attempt }}'
  );
  assert.equal(
    step(job, 'Retain the immutable candidate index record').with['if-no-files-found'],
    'error'
  );
  assert.equal(
    step(job, 'Retain the immutable candidate index record').with.name,
    'candidate-$' + '{{ matrix.id }}-$' + '{{ github.run_attempt }}'
  );
  assert.ok(
    !workflow.jobs['publish-container-images'].steps.some((s) =>
      s.uses?.startsWith('docker/build-push-action@')
    )
  );
});

test('manual release gate derives a nonpublishing worker image smoke matrix', () => {
  const matrixJob = workflow.jobs['container-image-matrix'];
  assert.match(
    matrixJob.if,
    /workflow_dispatch.*release-gate/u,
    'container image matrix must be available to the manual release gate'
  );
  assert.doesNotMatch(matrixJob.if, /release-preflight/u);
  assert.equal(matrixJob.needs, undefined);

  const producer = step(matrixJob, 'Read release image manifest');
  const outputFile = join(mkdtempSync(join(tmpdir(), 'openkit-release-matrix-')), 'output');
  try {
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', producer.run], {
      cwd: process.cwd(),
      env: { ...process.env, GITHUB_OUTPUT: outputFile },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const output = readFileSync(outputFile, 'utf8');
    const matrix = JSON.parse(output.match(/^worker-matrix=(.+)$/m)?.[1] ?? '{}');
    assert.deepEqual(
      matrix.include.map(({ id, platform }) => `${id}:${platform}`),
      [
        'worker-common:linux/amd64',
        'worker-common:linux/arm64',
        'worker-runtimes:linux/amd64',
        'worker-runtimes:linux/arm64',
      ]
    );
    for (const image of matrix.include) {
      assert.equal(
        image.runtimes,
        image.id === 'worker-common' ? '' : 'codex,pi,opencode,deepseek'
      );
      assert.equal(
        image.runner,
        image.platform === 'linux/arm64' ? 'ubuntu-24.04-arm' : 'ubuntu-24.04'
      );
      assert.equal(image.runtime, undefined);
      assert.equal(image.target, image.id);
    }
  } finally {
    rmSync(join(outputFile, '..'), { recursive: true, force: true });
  }

  const smokeJob = workflow.jobs['smoke-worker-images'];
  assert.ok(smokeJob, 'missing manual worker image smoke job');
  assert.match(smokeJob.if, /workflow_dispatch.*release-gate/u);
  assert.deepEqual(smokeJob.permissions, { contents: 'read' });
  assert.deepEqual(smokeJob.needs, ['container-image-matrix', 'candidate-plan']);
  assert.deepEqual(
    smokeJob.strategy.matrix,
    actionExpression('fromJSON(needs.container-image-matrix.outputs.worker-matrix)')
  );
  assert.equal(smokeJob['runs-on'], actionExpression('matrix.runner'));
  assert.ok(!smokeJob.steps.some((s) => s.uses?.startsWith('docker/setup-qemu-action@')));
  assert.ok(step(smokeJob, 'Set up Docker Buildx').uses);
  assert.equal(step(smokeJob, 'Build worker image').with.load, true);
  assert.equal(step(smokeJob, 'Build worker image').with.push, false);
  assert.equal(
    workflow.jobs['publish-container-images'].if,
    "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/')"
  );
  assert.ok(workflow.jobs['publish-container-images'].needs.includes('release-preflight'));
  assert.ok(
    !(smokeJob.steps ?? []).some(
      (candidate) =>
        /docker\/(?:login|build-push-action)/u.test(candidate.uses ?? '') &&
        /login-action/u.test(candidate.uses ?? '')
    )
  );
  assert.equal(
    step(smokeJob, 'Run worker image smoke').run,
    'bash scripts/docker/smoke-image.sh "${' + 'IMAGE_ID}"'
  );
  assert.equal(
    step(smokeJob, 'Run worker image smoke').env.DOCKER_DEFAULT_PLATFORM,
    actionExpression('matrix.platform')
  );
});

test('release workflow publishes and independently verifies the portable release bundle', () => {
  const preflight = workflow.jobs['release-preflight'];
  const githubRelease = workflow.jobs['github-release'];
  const verify = workflow.jobs['verify-release'];
  const download = step(verify, 'Download and verify GitHub Release assets');
  const anonymous = step(verify, 'Verify public worker base without registry credentials');

  assert.equal(preflight.needs, 'test-image');
  assert.deepEqual(preflight.permissions, { contents: 'read', packages: 'read' });
  assert.deepEqual(githubRelease.needs, [
    'package-release-assets',
    'qualify-nanohost',
    'publish-container-images',
  ]);
  assert.deepEqual(githubRelease.permissions, { contents: 'write' });
  assert.ok(step(githubRelease, 'Create immutable GitHub Release'));
  assert.deepEqual(verify.needs, ['test-image', 'github-release', 'publish-container-images']);
  assert.deepEqual(verify.permissions, { contents: 'read', packages: 'read' });
  assert.equal(download.env.GH_TOKEN, actionExpression('secrets.GITHUB_TOKEN'));
  assert.equal(download.env.TEST_IMAGE, actionExpression('needs.test-image.outputs.image'));
  assert.ok(verify.steps.indexOf(download) < verify.steps.indexOf(anonymous));
});

test('release workflow builds NanoHost natively and publishes one checksummed portable bundle', () => {
  const nativeEntry = Object.entries(workflow.jobs).find(
    ([, job]) => job['runs-on'] === 'ubuntu-24.04-arm'
  );
  assert.ok(nativeEntry, 'Missing native arm64 NanoHost build job');
  const [nativeJobId, nativeJob] = nativeEntry;
  assert.match(nativeJob.if, /refs\/tags/);
  const toolchain = nativeJob.steps.find((candidate) =>
    candidate.uses?.startsWith('jdx/mise-action@')
  );
  assert.ok(toolchain, 'Native build must provision the app-owned Rust pin through mise');
  assert.equal(toolchain.with?.working_directory, 'apps/nanohost');
  assert.equal(toolchain.with?.install_args, 'rust');
  const nativeCommands = (nativeJob.steps ?? [])
    .map((candidate) => candidate.run)
    .filter(Boolean)
    .join('\n');
  assert.match(nativeCommands, /cargo build --locked --release/);
  assert.match(nativeCommands, /nanohost --version/);
  assert.doesNotMatch(nativeCommands, /rustup|mise (?:exec|run)/u);
  assert.ok(
    nativeJob.steps.some((candidate) => candidate.uses?.startsWith('actions/upload-artifact@')),
    'Native build must hand off the raw NanoHost binary'
  );

  const portable = workflow.jobs['package-release-assets'];
  assert.ok(portable.needs.includes(nativeJobId));
  assert.ok(
    portable.steps.some((candidate) => candidate.uses?.startsWith('actions/download-artifact@')),
    'Portable packaging must download the native binary'
  );
  const portableCommands = portable.steps
    .map((candidate) => candidate.run)
    .filter(Boolean)
    .join('\n');
  assert.match(portableCommands, /verify-nanohost-release\.mjs/);
  assert.match(portableCommands, /verifyOperationsSkillArchive/);
  assert.doesNotMatch(portableCommands, /openkit-skill-/);
  assert.match(portableCommands, /skills\/openkit-ops\/scripts\/openkit/);
  assert.match(portableCommands, /openkit-nanohost-.*-linux-(?:arm64|\$\{architecture\})\.tar\.gz/);
  assert.match(portableCommands, /openkit-ops-skill-.*\.tar\.gz/);
  assert.match(portableCommands, /sha256sum -c SHA256SUMS/);
  const releaseStep = portable.steps.find(
    (candidate) =>
      candidate.id &&
      /GITHUB_OUTPUT/u.test(candidate.run ?? '') &&
      ['tag', 'commit', 'archive'].every((name) =>
        new RegExp(`(?:^|[^A-Za-z0-9_])${name}=`, 'u').test(candidate.run)
      )
  );
  assert.ok(releaseStep, 'Portable packaging must parse the supported OpenShell release once');
  assert.doesNotMatch(portableCommands, /v0\.0\.99|8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032/u);
  assert.doesNotMatch(portableCommands, /openshell-gateway-aarch64-unknown-linux-gnu\.tar\.gz/u);
  const releaseConsumer = portable.steps.find((candidate) =>
    /github\.com\/NVIDIA\/OpenShell\/releases\/download/u.test(candidate.run ?? '')
  );
  assert.ok(releaseConsumer, 'Portable packaging must download the parsed OpenShell coordinates');
  const releaseCoordinates = releaseConsumer.run
    .split('\n')
    .filter((line) => line.includes('github.com/NVIDIA/OpenShell/releases/download'));
  const sourceCoordinate = releaseConsumer.run
    .split('\n')
    .find((line) => line.includes('raw.githubusercontent.com/NVIDIA/OpenShell'));
  assert.equal(releaseCoordinates.length, 2, 'Both target Gateway archives must be downloaded');
  assert.ok(sourceCoordinate, 'Missing OpenShell source download coordinate');
  for (const [index, output] of ['amd64_archive', 'archive'].entries()) {
    assert.match(releaseCoordinates[index], outputReference(releaseStep, releaseConsumer, 'tag'));
    assert.match(releaseCoordinates[index], outputReference(releaseStep, releaseConsumer, output));
  }
  assert.match(sourceCoordinate, outputReference(releaseStep, releaseConsumer, 'commit'));

  const releaseCommands = workflow.jobs['github-release'].steps
    .map((candidate) => candidate.run)
    .filter(Boolean)
    .join('\n');
  assert.doesNotMatch(releaseCommands, /openkit-skill-.*\.tar\.gz/);
  assert.match(releaseCommands, /openkit-ops-skill-.*\.tar\.gz/);
  assert.match(releaseCommands, /openkit-nanohost-.*-linux-(?:arm64|\$\{architecture\})\.tar\.gz/);
  assert.match(releaseCommands, /portable-assets\/SHA256SUMS/);

  const verificationCommands = workflow.jobs['verify-release'].steps
    .map((candidate) => candidate.run)
    .filter(Boolean)
    .join('\n');
  assert.match(verificationCommands, /verify-nanohost-release\.mjs/);
  assert.match(verificationCommands, /verifyOperationsSkillArchive/);
  assert.doesNotMatch(verificationCommands, /openkit-skill-/);
  assert.match(verificationCommands, /skills\/openkit-ops\/scripts\/openkit/);
  assert.match(
    verificationCommands,
    /openkit-nanohost-.*-linux-(?:arm64|\$\{architecture\})\.tar\.gz/
  );
});

test('release workflow runs the fixed-path NanoHost installer gate in one host job', () => {
  const leaf = 'bash tests/support/nanohost-release-installer-live.sh';
  const matches = Object.entries(workflow.jobs).filter(([, job]) =>
    (job.steps ?? []).some((candidate) => candidate.run?.includes(leaf))
  );
  assert.equal(matches.length, 1, 'the NanoHost installer shell leaf must have one CI owner');
  const [jobId, job] = matches[0];
  assert.match(jobId, /nanohost.*installer|installer.*nanohost/u);
  assert.equal(job.container, undefined, 'the Bubblewrap gate must not run in test-env');
  assert.match(String(job['runs-on']), /^ubuntu-/u);
  const commands = (job.steps ?? [])
    .map((candidate) => candidate.run)
    .filter(Boolean)
    .join('\n');
  assert.match(
    commands,
    /apt-get install(?:\s+-y)?\s+bubblewrap|apt-get install\s+[^\n]*bubblewrap/u
  );
  assert.match(commands, new RegExp(escapeRegExp(leaf), 'u'));
  assert.doesNotMatch(commands, /pnpm .*nanohost.*installer|scripts\/test-env\.sh/u);
});

test('workspace portability uses two runners only behind release or manual gates', () => {
  const source = workflow.jobs['workspace-portability-source'];
  const target = workflow.jobs['workspace-portability-target'];

  assert.equal(source.if, target.if);
  assert.match(source.if, /github\.event_name == 'push'/u);
  assert.match(source.if, /github\.event_name == 'workflow_dispatch'/u);
  assert.doesNotMatch(source.if, /pull_request/u);
  assert.ok(target.needs.includes('workspace-portability-source'));
  assert.ok(workflow.jobs['package-release-assets'].needs.includes('workspace-portability-target'));
});

test('app-image recovery smoke is main-push or manual, host-placed, opted in, and root-Node pinned', () => {
  const job = workflow.jobs['app-image-admin-recovery'];
  assert.equal(
    job.if,
    `(github.event_name == 'push' && github.ref == 'refs/heads/main') || (github.event_name == 'workflow_dispatch' && contains(fromJSON('["smoke","release-gate","full"]'), inputs.gate))`
  );
  assert.doesNotMatch(job.if, /pull_request/u);
  assert.equal(job.container, undefined);
  assert.match(String(job['runs-on']), /^ubuntu-/u);

  const setup = step(job, 'Set up the pinned root Node toolchain');
  assert.match(setup.uses, /^jdx\/mise-action@[a-f0-9]{40}$/u);
  assert.deepEqual(setup.with, { install_args: 'node' });
  assert.equal(
    step(job, 'Build the disposable app image').run,
    'scripts/docker/build-image.sh app'
  );

  const smoke = step(job, 'Run the stopped-server recovery image smoke');
  assert.deepEqual(smoke.env, { OPENKIT_TEST_APP_IMAGE_RECOVERY: '1' });
  assert.equal(
    smoke.run,
    'bash scripts/test-env.sh host node --test scripts/docker/app-admin-recovery-smoke.test.mjs'
  );
});

function step(job, name) {
  const found = job.steps.find((candidate) => candidate.name === name);
  assert.ok(found, `Missing workflow step: ${name}`);
  return found;
}

/** Returns the serialized GitHub Actions expression parsed from workflow YAML. */
function actionExpression(value) {
  return `\${{ ${value} }}`;
}

function outputReference(producer, consumer, name) {
  const expression = actionExpression(`steps.${producer.id}.outputs.${name}`);
  if (consumer.run.includes(expression)) return new RegExp(escapeRegExp(expression), 'u');
  const environment = Object.entries(consumer.env ?? {}).find(([, value]) => value === expression);
  assert.ok(environment, `OpenShell ${name} output does not reach its download consumer`);
  const variable = escapeRegExp(environment[0]);
  return new RegExp(`(?:\\$${variable}(?![A-Za-z0-9_])|\\$\\{${variable}\\})`, 'u');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

test('release image metadata emits the plural catalog runtime label', () => {
  const identity = step(
    workflow.jobs['publish-container-images'],
    'Compute deterministic image identity'
  );
  assert.equal(identity.env.WORKER_RUNTIMES, actionExpression('matrix.runtimes'));
  assert.match(identity.run, /org\.openkit\.worker\.runtimes=/);
  assert.doesNotMatch(identity.run, /org\.openkit\.worker\.runtime=/);
});

test('release qualification runs both exact archives natively before publication', () => {
  const qualification = workflow.jobs['qualify-nanohost'];
  assert.ok(qualification, 'missing release-time NanoHost qualification');
  assert.equal(
    qualification.if,
    "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/')"
  );
  assert.equal(qualification.container, undefined);
  assert.equal(qualification.needs, 'package-release-assets');
  assert.deepEqual(qualification.permissions, { contents: 'read' });
  assert.deepEqual(qualification.strategy.matrix.include, [
    { runner: 'ubuntu-24.04', architecture: 'amd64' },
    { runner: 'ubuntu-24.04-arm', architecture: 'arm64' },
  ]);
  assert.equal(qualification['runs-on'], actionExpression('matrix.runner'));
  for (const architecture of ['amd64', 'arm64']) {
    const native = workflow.jobs[`build-nanohost-${architecture}`];
    assert.ok(native);
    assert.equal(native['runs-on'], architecture === 'amd64' ? 'ubuntu-24.04' : 'ubuntu-24.04-arm');
    assert.equal(native.if, qualification.if);
    assert.ok(
      workflow.jobs['package-release-assets'].needs.includes(`build-nanohost-${architecture}`)
    );
  }
  for (const publisher of ['github-release', 'publish-container-images']) {
    assert.ok(workflow.jobs[publisher].needs.includes('qualify-nanohost'));
  }
  const download = step(qualification, 'Download exact NanoHost archive and checksum');
  assert.equal(download.with.name, `nanohost-release-${actionExpression('matrix.architecture')}`);
  const commands = qualification.steps.map((entry) => entry.run ?? '').join('\n');
  assert.match(commands, /verify-nanohost-release\.mjs/);
  assert.match(commands, /install\.sh" --check-host/);
  assert.match(commands, /requirements-met/);
  assert.match(commands, /install\.sh" --check/);
  assert.match(commands, /ImageVersion/);
  assert.match(commands, /dpkg-query/);
  assert.doesNotMatch(commands, /systemctl|docker run|host:nanohost|worker.*job/);
});

test('release notes are checked before publication and verified against the generator', () => {
  const preflightCommands = workflow.jobs['release-preflight'].steps
    .map((entry) => entry.run ?? '')
    .join('\n');
  const publishCommands = workflow.jobs['publish-container-images'].steps
    .map((entry) => entry.run ?? '')
    .join('\n');
  const githubRelease = workflow.jobs['github-release'];
  const create = step(githubRelease, 'Create release notes');
  const verifyDownload = step(
    workflow.jobs['verify-release'],
    'Download and verify GitHub Release assets'
  );

  assert.match(preflightCommands, /scripts\/release-notes\.mjs --check/);
  assert.ok(step(githubRelease, 'Checkout'));
  assert.match(create.run, /scripts\/release-notes\.mjs/);
  assert.match(create.run, /--output release-notes\.md/);
  assert.match(publishCommands, /imagetools', 'inspect', '--raw'/);
  assert.match(publishCommands, /Platform manifest/);
  assert.match(verifyDownload.run, /scripts\/release-notes\.mjs/);
  assert.match(verifyDownload.run, /--compare-body/);
  assert.doesNotMatch(workflowBytes, /R001 exact-product no-host-reboot runtime gate remains open/);
});

// Unchanged jobs are pinned to reviewed main 23f3e2dc; cadence changes are checked separately below.
// release-preflight, publish-container-images, github-release, and verify-release were re-recorded for the release-notes generator.
// verify-release was re-recorded again when the published-body comparison moved into scripts/release-notes.mjs.
// publish-container-images was re-recorded when the App release build gained identity build arguments.
const unchangedJobBaseline = {
  'test-image': 'b0504dcc37a38fb459ba4ba8fc8400d50128765479cf6a3473a8717d068dfe38',
  'pr-check': '21bf4f4ac3b3d36600ca9d88daf93ac86c613397e545f1560b37a3fa63fd2885',
  'nanohost-installer': 'eb04e2ebaa480c04d22f8eaa91b776baa238a0cdae2e31462d282cf74b10481f',
  'release-preflight': 'b25f38ec37f6cb1e8524a84f981f8cc21f243c5bd5e8ce7d568c550a65b70ab8',
  'workspace-portability-source':
    'e33d1577679a0bba824a60d2ab8a2bf24e2f1a47608e872c824951efa70c6ace',
  'workspace-portability-target':
    '797453722686d9086ed90ccc253580ee7c74a87c3d41b2dec96a3b50bf6fcd27',
  'web-e2e': '9648f5055d4cbfb7dce59b6a7bf8609ed75ddd0125cc5972658c1643aaf919e0',
  smoke: '809f71ab17a0109adbc1775f9d7dcdb37118c99d38f30f8842981a09a925d048',
  'build-nanohost-amd64': '346b895871f280deff3d571843906b4952431d5dcf4870f64a53b7f140169180',
  'build-nanohost-arm64': 'd0b7cdb6291ef8eedacddda56ad81b8f602398ce35acd2ef3eb32a4ae9c9cf32',
  'package-release-assets': '9bb6035b4d43646481b89f1a40651ec23203e343a29a9506d209e5f551de4eea',
  'qualify-nanohost': '9c42422c9716a0ad27688e745ac4ca1716671c9709349dfdca2fd01abe619474',
  'publish-container-images': 'b57d664fa2429d70e32d736f2bbd8045e08b95b145895600371d4eadbd366386',
  'github-release': '342e687fc7bcb4773a791cc7d8925fb4bab7306f4cabade9513ac69238407cfd',
  'verify-release': '20c614ff0f1300b403789cfb9145f5ca26fdfa2f5482d7a3089f0682681b5c9f',
};

const candidateJobBaseline = {
  'candidate-plan': 'c043add46eb7d92273ec28af77bb7b896c333cdede70a3b71a123e006b86d033',
  'candidate-images': 'a0740482ba092070384eaadcc824d002b6ab9e593a3bf4d4f028ff8b4da81c7a',
  'candidate-index': '205763b1d946f852ef1cf2ae51b98bcd6adbba4b127c00bfc32f2e2ce410e89f',
};

const shardJobBaseline = {
  'l0-l2-plan': '3403258929b8dd4591044849751e483d55299489e41bb9e50a3c61fd0359631c',
  'l0-l2-shards': '90601da85c48559650162f822787172f86a93f8746e3a52ca78f10c8d084246a',
  'l0-l2': '3425b1ab09142a2a670502a5ae6d9d271b67a10fcdb0d86b29bec30fb6d43bfc',
};

test('publication and complete job graphs match their frozen implementation baselines', () => {
  const blocks = new Map(
    [
      ...workflowBytes
        .slice(workflowBytes.indexOf('jobs:\n') + 6)
        .matchAll(/^ {2}([a-z0-9-]+):\n(.*?)(?=^ {2}[a-z0-9-]+:\n|(?![\s\S]))/gms),
    ].map((match) => [match[1], match[2]])
  );
  assert.deepEqual(
    Object.keys(workflow.jobs)
      .filter(
        (name) =>
          ![
            'nano-core-e2e',
            'app-image-admin-recovery',
            'container-image-matrix',
            'smoke-worker-images',
          ].includes(name)
      )
      .sort(),
    Object.keys({ ...unchangedJobBaseline, ...shardJobBaseline, ...candidateJobBaseline }).sort()
  );
  for (const [name, digest] of Object.entries({
    ...unchangedJobBaseline,
    ...shardJobBaseline,
    ...candidateJobBaseline,
  })) {
    assert.equal(createHash('sha256').update(blocks.get(name)).digest('hex'), digest, name);
  }
});

test('only complete L0-L2 shards and NanoCore e2e can read exact-commit reuse evidence', () => {
  const selected = ['l0-l2-shards', 'nano-core-e2e'];
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (!selected.includes(name)) {
      assert.equal(
        job.permissions?.actions,
        name === 'publish-container-images' ? 'read' : undefined,
        name
      );
      assert.ok(!job.steps?.some((entry) => entry.id === 'reuse'), name);
      continue;
    }
    assert.deepEqual(job.permissions, { contents: 'read', packages: 'read', actions: 'read' });
    assert.deepEqual(
      job.needs,
      name === 'l0-l2-shards' ? ['test-image', 'l0-l2-plan'] : 'test-image'
    );
    assert.equal(job.container.image, actionExpression('needs.test-image.outputs.image'));
    assert.equal(job.steps[0].name, 'Checkout');
    const reuse = job.steps[1];
    assert.equal(reuse.id, 'reuse');
    assert.equal(
      reuse.if,
      name === 'l0-l2-shards'
        ? "github.event_name == 'push'"
        : "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/')"
    );
    assert.deepEqual(
      reuse.env,
      name === 'l0-l2-shards'
        ? {
            GITHUB_TOKEN: actionExpression('secrets.GITHUB_TOKEN'),
            SHARD_ID: actionExpression('matrix.id'),
          }
        : { GITHUB_TOKEN: actionExpression('secrets.GITHUB_TOKEN'), REUSE_JOB_NAME: job.name }
    );
    assert.match(reuse.run, /node scripts\/release-ci-reuse\.mjs/u);
    assert.match(reuse.run, /--repository "\$\{GITHUB_REPOSITORY\}"/u);
    assert.match(reuse.run, /--workflow ci\.yml/u);
    assert.match(reuse.run, /--sha "\$\{GITHUB_SHA\}"/u);
    assert.match(
      reuse.run,
      name === 'l0-l2-shards'
        ? /--job "L0-L2 shard \(\$\{SHARD_ID\}\)"/u
        : /--job "\$\{REUSE_JOB_NAME\}"/u
    );
    for (const later of job.steps.slice(2)) {
      if (later.name === 'Retain successful shard evidence') {
        assert.equal(later.if, undefined);
        assert.equal(later.with['if-no-files-found'], 'error');
      } else assert.equal(later.if, "steps.reuse.outputs.reused != 'true'", later.name);
    }
  }
});

test('reuse shell succeeds for proof and falls back on either unavailable or erroneous API evidence', () => {
  const directory = mkdtempSync(join(tmpdir(), 'openkit-release-reuse-step-'));
  try {
    writeFileSync(
      join(directory, 'node'),
      '#!/bin/sh\nprintf "%s\\n" "$REUSE_RESULT"\nexit "$REUSE_STATUS"\n',
      { mode: 0o755 }
    );
    for (const name of ['l0-l2-shards', 'nano-core-e2e']) {
      const reuse = step(
        workflow.jobs[name],
        name === 'l0-l2-shards'
          ? 'Reuse exact-commit candidate shard'
          : 'Reuse exact-commit candidate job'
      );
      for (const status of [0, 1, 2]) {
        const output = join(directory, 'output');
        const summary = join(directory, 'summary');
        writeFileSync(output, '');
        writeFileSync(summary, '');
        const proof = 'Reused run 10 attempt 2 job 20';
        const result = spawnSync('sh', ['-e', '-c', reuse.run], {
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            GITHUB_OUTPUT: output,
            GITHUB_STEP_SUMMARY: summary,
            GITHUB_REPOSITORY: 'example/openkit',
            GITHUB_SHA: 'a'.repeat(40),
            REUSE_JOB_NAME: workflow.jobs[name].name,
            SHARD_ID: 'protocol',
            REUSE_RESULT: proof,
            REUSE_STATUS: String(status),
          },
          encoding: 'utf8',
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(readFileSync(output, 'utf8'), `reused=${status === 0}\n`);
        assert.equal(readFileSync(summary, 'utf8'), status === 0 ? `${proof}\n` : '');
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Evaluate the finite GitHub job expressions with synthetic event contexts only. */
function jobRuns(id, event, ref, gate = '') {
  return Boolean(
    new Function(
      'github',
      'inputs',
      'contains',
      'fromJSON',
      'startsWith',
      'always',
      'needs',
      `return (${workflow.jobs[id].if.replace(/needs\.([a-z0-9-]+)/g, "needs['$1']")});`
    )(
      { event_name: event, ref },
      { gate },
      (values, value) => values.includes(value),
      JSON.parse,
      (value, prefix) => value.startsWith(prefix),
      () => true,
      { 'candidate-plan': { outputs: { enabled: 'false' } } }
    )
  );
}

test('every main push runs the complete nonpublishing candidate gate without publishing', () => {
  assert.deepEqual(workflow.on.push.branches, ['main']);
  assert.equal(workflow.on.push['paths-ignore'], undefined);
  assert.equal(workflow.on.push.paths, undefined);
  const gate = [
    'l0-l2',
    'nano-core-e2e',
    'workspace-portability-source',
    'workspace-portability-target',
    'smoke',
    'app-image-admin-recovery',
    'container-image-matrix',
    'smoke-worker-images',
  ];
  for (const id of gate) {
    assert.equal(jobRuns(id, 'push', 'refs/heads/main'), true, id);
    assert.equal(jobRuns(id, 'workflow_dispatch', 'refs/heads/main', 'release-gate'), true, id);
    assert.equal(jobRuns(id, 'pull_request', 'refs/pull/1/merge'), false, id);
  }
  for (const id of [
    'publish-container-images',
    'github-release',
    'verify-release',
    'release-preflight',
    'package-release-assets',
    'qualify-nanohost',
  ]) {
    assert.equal(jobRuns(id, 'push', 'refs/heads/main'), false, id);
    assert.equal(jobRuns(id, 'push', 'refs/tags/v0.1.0-rc.6'), true, id);
  }
  for (const id of ['app-image-admin-recovery', 'smoke-worker-images'])
    assert.equal(jobRuns(id, 'push', 'refs/heads/feature'), false, id);
  assert.equal(jobRuns('web-e2e', 'push', 'refs/heads/main'), false);
});

test('L0-L2 runs complete package coverage and native/root suites through a fail-closed aggregate', () => {
  const shards = workflow.jobs['l0-l2-shards'];
  const command = step(shards, 'Run one complete shard as the unprivileged image user');
  assert.match(command.run, /runuser -u node/u);
  assert.match(command.run, /node scripts\/ci-l0-l2\.mjs --run "\$\{SHARD_ID\}"/u);
  assert.equal(command.env.SHARD_ID, actionExpression('matrix.id'));
  assert.deepEqual(workflow.jobs['l0-l2'].needs, ['l0-l2-plan', 'l0-l2-shards']);
  assert.match(workflow.jobs['l0-l2'].if, /always\(\)/u);
  assert.match(
    step(workflow.jobs['l0-l2'], 'Require every shard job').run,
    /SHARDS_RESULT.*success/u
  );
  assert.match(
    step(workflow.jobs['l0-l2'], 'Require exactly one successful observation per shard').run,
    /--join temp\/ci-shards/u
  );
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
  assert.match(scripts['verify:l0-l2'], /pnpm run test:ci/u);
  assert.doesNotMatch(scripts['verify:l0-l2'], /test:unit|test:coverage/u);
  assert.match(scripts['test:ci'], /release-tests\.mjs/u);
});
