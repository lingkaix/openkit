import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { candidateMatrix } from '../scripts/release-candidate.mjs';
import { candidateJobs, publicationInputsAt } from '../scripts/release-publication-check.mjs';

const workflowBytes = readFileSync(join(process.cwd(), '.github', 'workflows', 'ci.yml'), 'utf8');
const workflow = parse(workflowBytes);

test('test image jobs reap orphaned processes through Docker init', () => {
  const jobs = Object.entries(workflow.jobs).filter(
    ([, job]) => job.container?.image === actionExpression('needs.test-image.outputs.image')
  );
  assert.equal(jobs.length, 11);
  for (const [name, job] of jobs) {
    assert.equal(job.container.options, '--init', `${name} must reap orphaned processes`);
  }
});

test('release workflow serializes tag releases and pins third-party actions', () => {
  assert.deepEqual(workflow.on.push.tags, ['v*.*.*-*']);
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

test('main pushes share one pending queue without cancelling the running head', () => {
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.equal(
    workflow.concurrency.group,
    actionExpression(
      "startsWith(github.ref, 'refs/tags/v') && 'openkit-release' || format('openkit-ci-{0}', github.ref)"
    )
  );
});

test('publication admission requires the complete exact-head gate including L4', () => {
  for (const id of ['l0-l2', 'nano-core-e2e', 'web-e2e', 'smoke'])
    assert.ok(candidateJobs.includes(workflow.jobs[id].name), id);
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
    const app = JSON.parse(output.match(/^app-matrix=(.+)$/m)?.[1] ?? '{}');
    const workers = JSON.parse(output.match(/^worker-publication-matrix=(.+)$/m)?.[1] ?? '{}');
    assert.deepEqual(
      app.include.map((image) => image.id),
      ['app']
    );
    assert.deepEqual(
      workers.include.map((image) => image.id),
      ['worker-common', 'worker-runtimes']
    );
    assert.equal(
      workflow.jobs['publish-container-images'].strategy.matrix,
      actionExpression('fromJSON(needs.container-image-matrix.outputs.worker-publication-matrix)')
    );
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
    'publish-app-image',
  ]);
  assert.deepEqual(githubRelease.permissions, { contents: 'write' });
  assert.ok(step(githubRelease, 'Create immutable GitHub Release'));
  assert.deepEqual(verify.needs, [
    'test-image',
    'github-release',
    'publish-container-images',
    'publish-app-image',
  ]);
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
  assert.equal(job['runs-on'], actionExpression('matrix.runner'));
  assert.deepEqual(job.strategy.matrix.runner, ['ubuntu-24.04', 'ubuntu-26.04']);
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

// Baselines retain reviewed job bytes; the test-image and installer conditions exclude only registry refresh.
// Other cadence changes are checked separately below.
// release-preflight, publish-container-images, github-release, and verify-release were re-recorded for the release-notes generator.
// verify-release was re-recorded again when the published-body comparison moved into scripts/release-notes.mjs.
// The App split re-records only the Worker matrix expression and final App dependency edges.
// P15 re-records only github-release and verify-release for the fifth attachment and downloaded-manifest check.
// Complete main verification adds L4 to main/release gates and the registry dependency; all other Web and registry steps stay unchanged.
// New App jobs are frozen below; an additional normalization check proves unchanged Worker and final steps.
// #533 re-records runner selection and the two-LTS installer matrix; all other job bytes stay frozen.
// CI speed proof adds shared build; completed worker probes are retired.
// The shard raw block changes only because its trailing temporary-probe comments are removed.
const unchangedJobBaseline = {
  'container-image-matrix': 'aaf9dbadd90c16a7be23c7198f043c96a0903ed9673f9692d070ff9a6d18a88d',
  'build-app-candidate': '11ee3d0655617efd27aaeaca35f343f331565e9423dac70191a178be29276e23',
  'smoke-app-native': '2038f6417de2a540d8f1ae7e2cba81124fae00d9ebf63cd854b570fc8e82dc5a',
  'publish-app-image': 'fd091214aaa75266c7e6556ce159ca083a1267906d8203c4a44888b6832c1b43',
  'test-image': 'eeae1d9c7553046e9cf830853571cd207733a866eabb4eddcccee0a1eea2f369',
  'pr-check': 'cd25e65862cb5e88de536194e5b12295c895d4135e447fa64674c29c6db0e876',
  'nanohost-installer': 'cca844e482336a7509a30d3c21f86a19ab1f516746bcebbffc12a2ffbbe7cf79',
  'release-preflight': '08f1323789664bc8fbf73981b43f4a6824671abd1b646d1f549dfa3a903f1b46',
  'workspace-portability-source':
    '3523621ad7a5e44d89f31c0fa8a16e36d52851bed3f7ed465fa524a0834d1cb3',
  'workspace-portability-target':
    '888af356cec6dcbda583fbd282374b15ff1b631039ed72fab02622c4cfb4d075',
  'web-e2e': 'e3cea381fd7e8d5b8e35ea3dae9de4b1cd861138f3846652daa0a09a2660a1c4',
  smoke: '3c5008e35fa7e6d3b985442158e07f2943b5d84486e2aec38007791bbcfc629f',
  'build-nanohost-amd64': '346b895871f280deff3d571843906b4952431d5dcf4870f64a53b7f140169180',
  'build-nanohost-arm64': 'd0b7cdb6291ef8eedacddda56ad81b8f602398ce35acd2ef3eb32a4ae9c9cf32',
  'package-release-assets': '7ca8192b75b1e6edcc18311c9592fd1a32304aea9394e201952a7be794412d5c',
  'qualify-nanohost': '9c42422c9716a0ad27688e745ac4ca1716671c9709349dfdca2fd01abe619474',
  'publish-container-images': '6007299806f13e1efff7c11e96f3f471b060e09d8887d1c06324fdaf418df6f0',
  'github-release': 'f8ce0250a5d129eda5de0c8e014221f3fe38ccff26b57fe2a920efd33025b720',
  'verify-release': '91c626072cb2dbe43b842c8ea833133a8b79ebedc3ac6e793e73f09423e2e592',
};

const candidateJobBaseline = {
  'candidate-registry': '0c3c8d8b738e5ce1a8f3d254441eeeac45fa219e989a2c59879a7ede943d7588',
  'candidate-plan': 'db39756a270124246cc1baa3586d4102530fa2af0cf4bd0efe276bd6092dc68d',
  'candidate-images': 'a0740482ba092070384eaadcc824d002b6ab9e593a3bf4d4f028ff8b4da81c7a',
  'candidate-index': '70619d1d39162da573cf6081651c89affe331cde53eb95b073f86da848f4dd0a',
};

const shardJobBaseline = {
  'l0-l2-plan': '041f28521062d0b5417be4096c278e31f9b1174eaee27a7f9340d5fb0fe57874',
  'l0-l2-build': 'd64709af62693597cde5f273c0c8ef1752f36609dce4ea30fdb1705467aeab2e',
  'l0-l2-shards': 'f7b5733bb480eb7e76d53824317099c608a2930d3662e217a14e8a12a7e1f55c',
  'l0-l2-coverage': '655073709e066f5323ce24839890cf12b32997a83ffe7121b54d24e4df55d7b6',
  'l0-l2': '2818f9a769eb36de77473ed949c3ed74284cd51c734e68985325430526b8dcc3',
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
          !['nano-core-e2e', 'app-image-admin-recovery', 'smoke-worker-images'].includes(name)
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

test('only complete L0-L2 shards, whole-owner coverage and NanoCore e2e read exact-job reuse evidence', () => {
  const selected = ['l0-l2-shards', 'l0-l2-coverage', 'nano-core-e2e'];
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (!selected.includes(name)) {
      assert.equal(
        job.permissions?.actions,
        ['publish-container-images', 'build-app-candidate', 'candidate-registry'].includes(name)
          ? 'read'
          : undefined,
        name
      );
      assert.ok(!job.steps?.some((entry) => entry.id === 'reuse'), name);
      continue;
    }
    const l0l2 = name !== 'nano-core-e2e';
    assert.deepEqual(job.permissions, { contents: 'read', packages: 'read', actions: 'read' });
    assert.deepEqual(
      job.needs,
      name === 'l0-l2-shards'
        ? ['test-image', 'l0-l2-plan', 'l0-l2-build']
        : name === 'l0-l2-coverage'
          ? ['test-image', 'l0-l2-plan', 'l0-l2-shards']
          : 'test-image'
    );
    assert.equal(job.container.image, actionExpression('needs.test-image.outputs.image'));
    assert.equal(job.steps[0].name, 'Checkout');
    const reuse = job.steps[1];
    assert.equal(reuse.id, 'reuse');
    assert.equal(
      reuse.if,
      l0l2
        ? "github.event_name == 'push'"
        : "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/')"
    );
    assert.deepEqual(
      reuse.env,
      l0l2
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
        : name === 'l0-l2-coverage'
          ? /--job "L0-L2 coverage \(\$\{SHARD_ID\}\)"/u
          : /--job "\$\{REUSE_JOB_NAME\}"/u
    );
    for (const later of job.steps.slice(2)) {
      if (later.uses?.startsWith('actions/upload-artifact@')) {
        assert.equal(later.if, name === 'l0-l2-shards' ? 'always()' : undefined);
        assert.equal(later.with['if-no-files-found'], 'error');
      } else if (later.name === 'Restore exact-commit execution evidence') {
        assert.equal(later.if, "steps.reuse.outputs.reused == 'true'");
      } else if (later.name === 'Inspect runner CPU and memory') {
        assert.equal(name, 'l0-l2-shards');
        assert.equal(later.if, "steps.reuse.outputs.reused != 'true' && matrix.id == 'nanocore-1'");
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
    for (const name of ['l0-l2-shards', 'l0-l2-coverage', 'nano-core-e2e']) {
      const reuse = step(
        workflow.jobs[name],
        name === 'l0-l2-shards'
          ? 'Reuse exact-commit candidate shard'
          : name === 'l0-l2-coverage'
            ? 'Reuse exact-commit candidate coverage'
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
        assert.equal(
          readFileSync(output, 'utf8'),
          status === 0 && name !== 'nano-core-e2e'
            ? 'reused=true\nrun_id=10\nattempt=2\n'
            : `reused=${status === 0}\n`
        );
        assert.equal(readFileSync(summary, 'utf8'), status === 0 ? `${proof}\n` : '');
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('artifact reuse refuses malformed or ambiguous successful proof before publishing outputs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'openkit-artifact-reuse-proof-'));
  try {
    writeFileSync(join(directory, 'node'), '#!/bin/sh\nprintf "%s\\n" "$REUSE_RESULT"\n', {
      mode: 0o755,
    });
    for (const id of ['l0-l2-shards', 'l0-l2-coverage']) {
      const reuse = workflow.jobs[id].steps.find((entry) => entry.id === 'reuse');
      for (const proof of [
        'Reused run 0 attempt 2 job 20',
        'Reused run 10 attempt 0 job 20',
        'Reused run 10 attempt 2 job x',
        'Reused run 10 attempt 2 job 20\nextra',
      ]) {
        const output = join(directory, 'output'),
          summary = join(directory, 'summary');
        writeFileSync(output, '');
        writeFileSync(summary, '');
        const result = spawnSync('sh', ['-eu', '-c', reuse.run], {
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            GITHUB_OUTPUT: output,
            GITHUB_STEP_SUMMARY: summary,
            GITHUB_REPOSITORY: 'example/openkit',
            GITHUB_SHA: 'a'.repeat(40),
            SHARD_ID: 'nanocore-1',
            REUSE_RESULT: proof,
          },
          encoding: 'utf8',
        });
        assert.notEqual(result.status, 0, proof);
        assert.match(result.stderr, /Invalid exact-job reuse proof/u);
        assert.equal(readFileSync(output, 'utf8'), '');
        assert.equal(readFileSync(summary, 'utf8'), '');
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
      `return (${(workflow.jobs[id].if ?? 'true').replace(/needs\.([a-z0-9-]+)/g, "needs['$1']")});`
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
    'l0-l2-plan',
    'l0-l2-shards',
    'l0-l2-coverage',
    'l0-l2',
    'nano-core-e2e',
    'web-e2e',
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
    'build-app-candidate',
    'smoke-app-native',
    'publish-app-image',
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
  for (const event of ['pull_request', 'push']) {
    assert.equal(jobRuns('web-e2e', event, 'refs/heads/feature'), false);
    assert.equal(jobRuns('web-e2e', event, 'refs/tags/v0.1.0-rc.9'), false);
  }
  assert.equal(jobRuns('web-e2e', 'workflow_dispatch', 'refs/heads/main', 'full'), true);
  assert.equal(jobRuns('web-e2e', 'workflow_dispatch', 'refs/heads/main', 'web-e2e'), true);
});

test('CI keeps NanoHost scheduling in its package and preserves inherited harness settings', () => {
  const nativePackage = JSON.parse(readFileSync('apps/nanohost/package.json', 'utf8'));
  assert.match(nativePackage.scripts.test, /\bcargo test\b.*--test-threads=1\b/u);
  const command = step(
    workflow.jobs['l0-l2-shards'],
    'Run one complete shard as the unprivileged image user'
  );
  const setup = command.run.slice(command.run.indexOf('\n') + 1, command.run.indexOf('runuser'));
  assert.doesNotMatch(setup, /chown|runuser/u);
  for (const id of ['native-nanohost', 'native-other', 'root', 'web']) {
    for (const inherited of [undefined, '7']) {
      const env = { ...process.env, SHARD_ID: id };
      if (inherited === undefined) delete env.RUST_TEST_THREADS;
      else env.RUST_TEST_THREADS = inherited;
      const result = spawnSync(
        'sh',
        ['-eu', '-c', `${setup}\nprintf %s "\${RUST_TEST_THREADS-unset}"`],
        { env, encoding: 'utf8' }
      );
      assert.equal(result.status, 0, id);
      assert.equal(result.stdout, inherited ?? 'unset', id);
    }
  }
});

test('L0-L2 runs complete package coverage and native/root suites through a fail-closed aggregate', () => {
  const shards = workflow.jobs['l0-l2-shards'];
  const command = step(shards, 'Run one complete shard as the unprivileged image user');
  assert.match(command.run, /runuser -u node/u);
  assert.match(command.run, /node scripts\/ci-l0-l2\.mjs --run "\$\{SHARD_ID\}"/u);
  assert.equal(command.env.SHARD_ID, actionExpression('matrix.id'));
  assert.deepEqual(workflow.jobs['l0-l2'].needs, ['l0-l2-plan', 'l0-l2-shards', 'l0-l2-coverage']);
  assert.match(workflow.jobs['l0-l2'].if, /always\(\)/u);
  assert.match(
    step(workflow.jobs['l0-l2'], 'Require every shard job').run,
    /SHARDS_RESULT.*success.*COVERAGE_RESULT.*success/u
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

test('App publication waits for exact-manifest smoke on both native hosts', () => {
  const build = workflow.jobs['build-app-candidate'];
  const native = workflow.jobs['smoke-app-native'];
  const publish = workflow.jobs['publish-app-image'];
  assert.ok(build, 'tag-stage App candidate admission is required');
  assert.equal(build.name, `Read ${actionExpression('matrix.id')} candidate`);
  assert.equal(publish.name, `Publish ${actionExpression('matrix.id')} image`);
  assert.ok(native, 'native App platform gate is required');
  assert.ok(publish, 'App promotion joins the native platform gate');
  assert.equal(native['runs-on'], actionExpression('matrix.runner'));
  assert.deepEqual(native.strategy.matrix.include, [
    { platform: 'linux/amd64', runner: 'ubuntu-24.04', architecture: 'X64' },
    { platform: 'linux/arm64', runner: 'ubuntu-24.04-arm', architecture: 'ARM64' },
  ]);
  assert.equal(native.strategy['fail-fast'], false);
  assert.ok(publish.needs.includes('smoke-app-native'));
  assert.ok(!native.steps.some((entry) => entry.uses?.startsWith('docker/setup-qemu-action@')));
});

test('native App evidence refuses missing, skipped, failed and mismatched platforms', async () => {
  const { verifyNativeEvidence, verifyNativeHost } = await import(
    '../scripts/release-app-native.mjs'
  );
  const candidate = {
    repository: 'example/openkit',
    source: 'a'.repeat(40),
    tag: 'v0.1.0-rc.8',
    runId: '123',
    attempt: '1',
    image: 'ghcr.io/example/openkit-app',
    digest: `sha256:${'b'.repeat(64)}`,
    platforms: ['amd64', 'arm64'].map((arch, i) => ({
      platform: `linux/${arch}`,
      digest: `sha256:${String(i + 1).repeat(64)}`,
    })),
  };
  const host = (architecture) => ({
    system: 'Linux',
    kernel: architecture === 'amd64' ? 'x86_64' : 'aarch64',
    node: architecture === 'amd64' ? 'x64' : 'arm64',
    runner: architecture === 'amd64' ? 'X64' : 'ARM64',
    docker: `linux/${architecture}`,
    endpoint: 'unix:///var/run/docker.sock',
  });
  const good = candidate.platforms.map((entry) => ({
    ...candidate,
    ...entry,
    indexDigest: candidate.digest,
    host: host(entry.platform.split('/')[1]),
    conclusion: 'success',
    negativeFixture: 'address-space-assertion',
    inheritedAddressSpace: 'unlimited',
  }));
  assert.doesNotThrow(() => verifyNativeEvidence(candidate, good));
  assert.throws(() => verifyNativeHost('linux/arm64', host('amd64')), /native host/);
  for (const key of ['kernel', 'node', 'runner', 'docker', 'endpoint']) {
    const changed = { ...host('arm64'), [key]: host('amd64')[key] };
    if (key === 'endpoint') changed.endpoint = 'tcp://remote:2375';
    assert.throws(() => verifyNativeHost('linux/arm64', changed), /native host/, key);
  }
  for (const conclusion of ['skipped', 'failure', 'cancelled', undefined]) {
    assert.throws(
      () => verifyNativeEvidence(candidate, [good[0], { ...good[1], conclusion }]),
      /native evidence/
    );
  }
  assert.throws(() => verifyNativeEvidence(candidate, good.slice(0, 1)), /native evidence/);
  assert.throws(() => verifyNativeEvidence(candidate, [good[0], good[0]]), /native evidence/);
  for (const field of [
    'source',
    'tag',
    'runId',
    'attempt',
    'repository',
    'image',
    'indexDigest',
    'digest',
    'negativeFixture',
    'inheritedAddressSpace',
  ]) {
    assert.throws(
      () => verifyNativeEvidence(candidate, [good[0], { ...good[1], [field]: 'wrong' }]),
      /native evidence/,
      field
    );
  }
});

test('Worker publication and final verification retain the reviewed cadence steps', () => {
  const blocks = new Map(
    [
      ...workflowBytes
        .slice(workflowBytes.indexOf('jobs:\n') + 6)
        .matchAll(/^ {2}([a-z0-9-]+):\n(.*?)(?=^ {2}[a-z0-9-]+:\n|(?![\s\S]))/gms),
    ].map((match) => [match[1], match[2]])
  );
  const old = {
    'publish-container-images': 'd815c292f966f1f5f99a1cb622304379c1c51101bbf85efb2f3517f2ebab11f5',
    'github-release': '164bbfa536d6b14d53b74b960234a5e6038a6f5bfecf5088b14f6e501291ec9a',
    'verify-release': '670f751bd1aba453021c52f18bba320544d9e09aecda5f1d861807fa71e9f16c',
  };
  for (const [name, digest] of Object.entries(old)) {
    const normalized = blocks
      .get(name)
      .replace('outputs.worker-publication-matrix)', 'outputs.matrix)')
      .replace('      - publish-app-image\n', '');
    assert.equal(createHash('sha256').update(normalized).digest('hex'), digest, name);
  }
});

test('publication proof covers every App producer, consumer and native fixture byte', () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-native-publication-'));
  try {
    const git = (args, input) => {
      const r = spawnSync('git', args, { cwd: root, input, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    git(['init', '--initial-branch=main']);
    for (const directory of ['.github/workflows', 'scripts', 'containers'])
      mkdirSync(join(root, directory), { recursive: true });
    for (const file of [
      'scripts/release-app-native.mjs',
      'scripts/release-app-no-as-limit.c',
      'containers/images.json',
    ])
      writeFileSync(join(root, file), readFileSync(file));
    const jobs = [
      'publish-container-images',
      'github-release',
      'verify-release',
      'container-image-matrix',
      'build-app-candidate',
      'smoke-app-native',
      'publish-app-image',
    ];
    writeFileSync(
      join(root, '.github/workflows/ci.yml'),
      'jobs:\n' +
        jobs
          .map(
            (name) => `  ${name}:\n    steps:\n      - run: node scripts/release-app-native.mjs\n`
          )
          .join('')
    );
    const snapshot = () => {
      git(['add', '.']);
      return git(
        ['hash-object', '-t', 'commit', '-w', '--stdin'],
        `tree ${git(['write-tree'])}\nauthor Fixture <fixture.invalid> 0 +0000\ncommitter Fixture <fixture.invalid> 0 +0000\n\nFixture\n`
      );
    };
    const before = publicationInputsAt(root, snapshot());
    assert.deepEqual(Object.keys(before.jobs).sort(), jobs.sort());
    assert.deepEqual(
      Object.keys(before.files).sort(),
      [
        'containers/images.json',
        'scripts/release-app-native.mjs',
        'scripts/release-app-no-as-limit.c',
      ].sort()
    );
    writeFileSync(
      join(root, '.github/workflows/release-promotion.yml'),
      'jobs:\n  promote:\n    steps:\n      - run: node scripts/promotion-fixture.mjs\n'
    );
    writeFileSync(join(root, 'scripts/promotion-fixture.mjs'), 'export const version = 1;\n');
    const promoted = publicationInputsAt(root, snapshot());
    assert.ok(promoted.jobs['stable-promotion-workflow']);
    assert.ok(promoted.files['.github/workflows/release-promotion.yml']);
    assert.ok(promoted.files['scripts/promotion-fixture.mjs']);
    writeFileSync(join(root, 'scripts/promotion-fixture.mjs'), 'export const version = 2;\n');
    assert.notEqual(publicationInputsAt(root, snapshot()).sha256, promoted.sha256);
    writeFileSync(join(root, 'scripts/release-app-no-as-limit.c'), 'fixture changed\n');
    assert.notEqual(publicationInputsAt(root, snapshot()).sha256, before.sha256);
    const path = join(root, '.github/workflows/ci.yml');
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace('  smoke-app-native:\n', '  missing-native:\n')
    );
    assert.throws(
      () => publicationInputsAt(root, snapshot()),
      /publication job missing: smoke-app-native/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Harness admission only: stand-ins exercise driver outcomes, never container or product behavior.
test('native App driver admits success and refuses wrong host, false negatives, product failure and timeout', () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-native-driver-'));
  try {
    const platform = process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64';
    const candidate = {
      repository: 'example/openkit',
      source: 'a'.repeat(40),
      tag: 'v0.1.0-rc.8',
      runId: '123',
      attempt: '1',
      image: 'ghcr.io/example/openkit-app',
      digest: `sha256:${'b'.repeat(64)}`,
      platforms: ['amd64', 'arm64'].map((arch, i) => ({
        platform: `linux/${arch}`,
        digest: `sha256:${String(i + 1).repeat(64)}`,
      })),
      smokeCommand: 'openkit-app-smoke',
      reused: false,
      latestBefore: '',
    };
    const input = join(root, 'candidate.json');
    writeFileSync(input, JSON.stringify(candidate));
    const bootstrap = `
      import { mock } from 'node:test';
      import { appendFileSync } from 'node:fs';
      import { pathToFileURL } from 'node:url';
      const mode = process.env.DRIVER_MODE;
      const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
      mock.module('node:child_process', { namedExports: { spawnSync(program, args) {
        const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
        if (program === 'uname') return ok(args[0] === '-s' ? 'Linux' :
          mode === 'wrong-host' ? 'wrong-kernel' : arch === 'arm64' ? 'aarch64' : 'x86_64');
        if (program === 'cc') return ok();
        if (program !== 'docker') throw Error('Unexpected program ' + program);
        appendFileSync(process.env.DRIVER_LOG, JSON.stringify(args) + '\\n');
        if (args[0] === 'buildx') return ok(JSON.stringify({ manifests: ['amd64', 'arm64'].map((architecture, i) =>
          ({ platform: { os: 'linux', architecture }, digest: 'sha256:' + String(i + 1).repeat(64) })) }));
        if (args[0] === 'context') return ok(args[1] === 'show' ? 'default' : 'unix:///var/run/docker.sock');
        if (args[0] === 'info') return ok('linux/' + arch);
        if (args[0] === 'pull') return ok();
        if (args[0] !== 'run') throw Error('Unexpected Docker command ' + args[0]);
        if (args.includes('LD_PRELOAD=/tmp/no-as-limit.so')) {
          if (mode === 'negative-passes') return ok();
          if (mode === 'negative-unrelated') return { status: 1, stdout: '', stderr: 'unrelated failure' };
          if (mode === 'negative-timeout') return { status: null, error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) };
          return { status: 1, stdout: '', stderr: 'ERR_ASSERTION 2147483648 Max address space unlimited unlimited bytes' };
        }
        if (args.includes('ulimit -v')) return ok(mode === 'inherited-limit' ? '2097152' : 'unlimited');
        if (mode === 'product-failure') return { status: 42, stdout: '', stderr: 'product failed' };
        if (mode === 'product-timeout') return { status: null, error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) };
        return ok();
      } } });
      process.argv = [process.execPath, process.env.DRIVER_HELPER, 'smoke', process.env.DRIVER_INPUT, process.env.DRIVER_PLATFORM, process.env.DRIVER_OUTPUT];
      await import(pathToFileURL(process.env.DRIVER_HELPER).href);
    `;
    for (const mode of [
      'success',
      'wrong-host',
      'inherited-limit',
      'negative-passes',
      'negative-unrelated',
      'negative-timeout',
      'product-failure',
      'product-timeout',
    ]) {
      const output = join(root, `${mode}.json`);
      const log = join(root, `${mode}.log`);
      const r = spawnSync(
        process.execPath,
        ['--experimental-test-module-mocks', '--input-type=module', '--eval', bootstrap],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            GITHUB_SHA: candidate.source,
            GITHUB_REPOSITORY: candidate.repository,
            GITHUB_REPOSITORY_OWNER: 'example',
            GITHUB_EVENT_NAME: 'push',
            GITHUB_REF: `refs/tags/${candidate.tag}`,
            GITHUB_REF_NAME: candidate.tag,
            GITHUB_RUN_ID: candidate.runId,
            GITHUB_RUN_ATTEMPT: candidate.attempt,
            RUNNER_ARCH: process.arch === 'arm64' ? 'ARM64' : 'X64',
            DOCKER_HOST: '',
            DOCKER_CONTEXT: '',
            DRIVER_MODE: mode,
            DRIVER_LOG: log,
            DRIVER_HELPER: join(process.cwd(), 'scripts/release-app-native.mjs'),
            DRIVER_INPUT: input,
            DRIVER_PLATFORM: platform,
            DRIVER_OUTPUT: output,
          },
        }
      );
      assert.equal(r.error, undefined);
      if (mode === 'success') {
        assert.equal(r.status, 0, r.stderr);
        assert.equal(JSON.parse(readFileSync(output, 'utf8')).conclusion, 'success');
      } else {
        assert.equal(r.status, 1, `${mode}: ${r.stderr}`);
        assert.throws(() => readFileSync(output), { code: 'ENOENT' }, mode);
      }
      const calls = readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const runs = calls.filter((args) => args[0] === 'run');
      if (mode === 'wrong-host') {
        assert.equal(runs.length, 0);
        assert.ok(!calls.some((args) => args[0] === 'pull'));
      }
      if (mode === 'success') {
        assert.equal(runs.length, 3);
        assert.ok(runs[1].includes('test "$(ulimit -v)" = unlimited; exec "$@"'));
        const manifest = candidate.platforms.find((p) => p.platform === platform).digest;
        assert.ok(runs.every((args) => args.includes(`${candidate.image}@${manifest}`)));
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Cargo target cache retains the image-owned dictionary build output with its absolute include paths', () => {
  const dockerfile = readFileSync('containers/test-env/Dockerfile', 'utf8');
  const dictionary = dockerfile.match(/^ENV LINDERA_BUILD_DICTIONARY_CACHE_DIR="([^"]+)"$/mu)?.[1];
  assert.ok(dictionary);
  const cache = step(workflow.jobs['l0-l2-shards'], 'Cache locked build inputs and outputs');
  assert.ok(cache.with.path.trim().split('\n').includes(dictionary));
});

test('registry admission runs after complete gates with read-only package authority and supports observation-only refresh', () => {
  const job = workflow.jobs['candidate-registry'];
  assert.deepEqual(job.permissions, { contents: 'read', actions: 'read', packages: 'read' });
  assert.deepEqual(job.needs, [
    'candidate-plan',
    'candidate-index',
    'l0-l2',
    'nano-core-e2e',
    'web-e2e',
    'smoke',
    'workspace-portability-target',
    'app-image-admin-recovery',
    'nanohost-installer',
  ]);
  for (const prerequisite of job.needs.filter((n) => n !== 'candidate-plan'))
    assert.ok(job.if.includes(`needs.${prerequisite}.result == 'success'`));
  assert.match(job.if, /inputs.gate == 'registry-admission'/);
  const inspect = step(job, 'Inspect retained candidate indexes and immutable release identities');
  assert.match(inspect.run, /release-registry-evidence.mjs/);
  assert.equal(inspect.env.GITHUB_TOKEN, actionExpression('secrets.GITHUB_TOKEN'));
  const retain = step(job, 'Retain exact-P registry admission evidence');
  assert.equal(retain.with.name, 'registry-admission-$' + '{{ github.run_attempt }}');
  assert.equal(retain.with['if-no-files-found'], 'error');
  assert.ok(!job.steps.some((s) => s.uses?.startsWith('docker/build-push-action@')));
});

test('registry-only refresh runs exactly the read-only observation job and preserves all existing bootstrap gates', () => {
  const selected = Object.keys(workflow.jobs).filter((id) =>
    jobRuns(id, 'workflow_dispatch', 'refs/heads/candidate', 'registry-admission')
  );
  assert.deepEqual(selected, ['candidate-registry']);
  for (const id of ['test-image', 'nanohost-installer']) {
    for (const [event, ref] of [
      ['pull_request', 'refs/pull/1/merge'],
      ['push', 'refs/heads/main'],
      ['push', 'refs/tags/v0.1.0-rc.8'],
    ])
      assert.equal(jobRuns(id, event, ref), true, `${id}: ${event} ${ref}`);
    for (const gate of workflow.on.workflow_dispatch.inputs.gate.options.filter(
      (g) => g !== 'registry-admission'
    ))
      assert.equal(
        jobRuns(id, 'workflow_dispatch', 'refs/heads/candidate', gate),
        true,
        `${id}: ${gate}`
      );
  }
});

// The tag joins fresh native proof to the already-qualified candidate without constructing new bytes.
test('App tag admission fetches the proved candidate and cannot rebuild it', () => {
  const job = workflow.jobs['build-app-candidate'];
  assert.ok(!job.steps.some((s) => s.uses?.startsWith('docker/build-push-action@')));
  assert.ok(!job.steps.some((s) => s.uses?.startsWith('docker/setup-qemu-action@')));
  assert.deepEqual(job.permissions, { contents: 'read', actions: 'read', packages: 'read' });
  const fetch = step(job, 'Fetch proved App candidate');
  assert.match(fetch.run, /release-candidate\.mjs fetch --id app/);
  assert.equal(fetch.env.GITHUB_TOKEN, actionExpression('secrets.GITHUB_TOKEN'));
  const digest = step(job, 'Resolve candidate digest');
  assert.match(digest.run, /CANDIDATE_DIGEST/);
  assert.match(digest.run, /EXISTING_DIGEST/);
  assert.match(digest.run, /exit 1/);
  assert.ok(workflow.jobs['smoke-app-native'].needs === 'build-app-candidate');
  assert.ok(workflow.jobs['publish-app-image'].needs.includes('smoke-app-native'));
});

// Execute the workflow-owned digest branch; an unproved or different digest must never be a retry fallback.
test('App tag digest selection refuses missing proof and immutable disagreement', () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-app-candidate-selection-'));
  const candidate = `sha256:${'a'.repeat(64)}`;
  const other = `sha256:${'b'.repeat(64)}`;
  try {
    for (const [name, present, digest, existing, success] of [
      ['new', 'false', candidate, '', true],
      ['exact-retry', 'true', candidate, candidate, true],
      ['different', 'true', candidate, other, false],
      ['missing', 'true', '', candidate, false],
      ['invalid', 'false', 'invalid', '', false],
    ]) {
      const output = join(root, name);
      const result = spawnSync(
        'bash',
        ['-c', step(workflow.jobs['build-app-candidate'], 'Resolve candidate digest').run],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PRESENT: present,
            CANDIDATE_DIGEST: digest,
            EXISTING_DIGEST: existing,
            GITHUB_OUTPUT: output,
          },
        }
      );
      assert.equal(result.status === 0, success, name);
      if (success) {
        assert.equal(readFileSync(output, 'utf8'), `digest=${candidate}\nreused=${present}\n`);
      } else {
        assert.throws(() => readFileSync(output), { code: 'ENOENT' }, name);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('manifest publication is required before notes and the existing immutable uploader carries all five assets', () => {
  const publish = workflow.jobs['github-release'];
  const manifest = step(publish, 'Generate release manifest and checksum');
  assert.ok(
    publish.steps.indexOf(manifest) < publish.steps.indexOf(step(publish, 'Create release notes'))
  );
  assert.match(manifest.run, /release-record\.mjs[\s\S]*--publication-assets portable-assets/u);
  assert.match(
    step(publish, 'Create immutable GitHub Release').run,
    /portable-assets\/openkit-release-\$\{GITHUB_REF_NAME\}\.json/u
  );
  const verification = step(
    workflow.jobs['verify-release'],
    'Download and verify GitHub Release assets'
  ).run;
  assert.match(verification, /openkit-release-\$\{process.env.GITHUB_REF_NAME\}\.json/u);
  assert.match(
    verification,
    /release-record\.mjs[\s\S]*--verify-publication-assets release-download/u
  );
});

test('stable rehearsal is tag-only, scratch-only, serialized and has no construction path', () => {
  const stable = parse(readFileSync('.github/workflows/release-promotion.yml', 'utf8'));
  assert.deepEqual(stable.on.push.tags, ['v*.*.*', '!v*.*.*-*']);
  assert.deepEqual(Object.keys(stable.on), ['push']);
  assert.deepEqual(stable.permissions, {});
  assert.equal(stable.concurrency.group, 'openkit-release');
  assert.equal(stable.concurrency['cancel-in-progress'], false);
  const job = stable.jobs.promote;
  assert.equal(job.steps[0].name, 'Require bounded scratch authority');
  assert.match(job.steps[0].run, /notrucked\/openkit/u);
  assert.match(job.steps[0].run, /R001 remains open/u);
  assert.ok(job.steps.find((s) => s.run?.includes('release-promotion.mjs')));
  const commands = job.steps.map((s) => s.run ?? '').join('\n');
  assert.doesNotMatch(
    commands,
    /(?:docker|pnpm|cargo) (?:build|buildx build)|package-release-assets\.mjs/u
  );
  for (const entry of job.steps) if (entry.uses) assert.match(entry.uses, /^[^@]+@[a-f0-9]{40}$/u);
  assert.match(readFileSync('scripts/release-preflight.mjs', 'utf8'), /requirePrerelease: true/u);
});

test('partitioned coverage merges the complete current-attempt reports without a product build', () => {
  const plan = workflow.jobs['l0-l2-plan'];
  assert.equal(plan.outputs.coverage, actionExpression('steps.plan.outputs.coverage'));
  assert.match(step(plan, 'Derive complete deterministic owners').run, /--coverage-matrix/u);
  const merge = workflow.jobs['l0-l2-coverage'];
  assert.ok(merge, 'whole-owner coverage is a required job');
  assert.equal(merge.name, `L0-L2 coverage (${actionExpression('matrix.id')})`);
  assert.deepEqual(merge.needs, ['test-image', 'l0-l2-plan', 'l0-l2-shards']);
  assert.equal(
    merge.strategy.matrix,
    actionExpression('fromJSON(needs.l0-l2-plan.outputs.coverage)')
  );
  assert.equal(merge.container.image, actionExpression('needs.test-image.outputs.image'));
  assert.equal(merge.permissions.actions, 'read');
  assert.equal(merge.if, workflow.jobs['l0-l2-shards'].if);
  const sharedBuild = step(merge, 'Restore shared build cache');
  assert.deepEqual(sharedBuild, step(workflow.jobs['l0-l2-shards'], 'Restore shared build cache'));
  assert.ok(
    merge.steps.indexOf(sharedBuild) <
      merge.steps.indexOf(step(merge, 'Merge whole-owner coverage as the unprivileged image user'))
  );
  const download = step(merge, 'Download current-attempt coverage partitions');
  assert.equal(
    download.with.pattern,
    `l0-l2-${actionExpression('matrix.id')}-*-attempt-${actionExpression('github.run_attempt')}`
  );
  assert.equal(download.with.path, 'temp/ci-shards');
  assert.equal(download.with['merge-multiple'], true);
  const commands = merge.steps.map((entry) => entry.run ?? '').join('\n');
  assert.match(commands, /pnpm install --frozen-lockfile/u);
  assert.match(
    commands,
    /runuser -u node -- env HOME="\$\{HOME\}" node scripts\/ci-l0-l2\.mjs --merge-coverage/u
  );
  assert.doesNotMatch(commands, /pnpm[^\n]*\bbuild\b|--run /u);
  const retained = step(merge, 'Retain successful coverage evidence');
  assert.equal(
    retained.with.name,
    `l0-l2-${actionExpression('matrix.id')}-coverage-attempt-${actionExpression('github.run_attempt')}`
  );
  assert.match(retained.with.path, /-coverage\.json/u);
  assert.match(retained.with.path, /-merged-execution\.report/u);
  assert.doesNotMatch(retained.with.path, /blobs|\*|inventory/u);
  assert.deepEqual(workflow.jobs['l0-l2'].needs, ['l0-l2-plan', 'l0-l2-shards', 'l0-l2-coverage']);
});

test('exact-job reuse restores attempt-bound reports instead of manufacturing success', () => {
  for (const [id, artifact] of [
    ['l0-l2-shards', ''],
    ['l0-l2-coverage', '-coverage'],
  ]) {
    const job = workflow.jobs[id];
    assert.ok(job);
    const reuse = job.steps.find((entry) => entry.id === 'reuse');
    assert.doesNotMatch(reuse.run, /writeFileSync|mkdir|conclusion|rootNodeInventory/u);
    assert.match(reuse.run, /run_id=/u);
    assert.match(reuse.run, /attempt=/u);
    const restored = step(job, 'Restore exact-commit execution evidence');
    assert.equal(restored.if, "steps.reuse.outputs.reused == 'true'");
    assert.equal(restored.with['run-id'], actionExpression('steps.reuse.outputs.run_id'));
    assert.equal(restored.with['github-token'], actionExpression('secrets.GITHUB_TOKEN'));
    assert.equal(
      restored.with.name,
      `l0-l2-${actionExpression('matrix.id')}${artifact}-attempt-${actionExpression('steps.reuse.outputs.attempt')}`
    );
    assert.equal(restored.with.path, 'temp/ci-shards');
  }
  const cache = step(workflow.jobs['l0-l2-shards'], 'Cache locked build inputs and outputs');
  assert.match(cache.uses, /^actions\/cache\/restore@[a-f0-9]{40}$/u);
  const retained = workflow.jobs['l0-l2-shards'].steps.find((entry) =>
    entry.uses?.startsWith('actions/upload-artifact@')
  );
  assert.equal(
    retained.with.name,
    `l0-l2-${actionExpression('matrix.id')}-attempt-${actionExpression('github.run_attempt')}`
  );
  assert.equal(
    step(workflow.jobs['l0-l2'], 'Download complete shard observations').with.pattern,
    `l0-l2-*-attempt-${actionExpression('github.run_attempt')}`
  );
});
