import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { publicationInputsAt } from '../scripts/release-publication-check.mjs';

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

test('release workflow passes release identity build args to the App image only', () => {
  const job = workflow.jobs['build-app-candidate'];
  const identity = step(job, 'Pass App release identity build arguments');
  const candidate = step(job, 'Build digest-only release candidate');
  const workerBuild = step(workflow.jobs['smoke-worker-images'], 'Build worker image');

  assert.equal(identity.if, "matrix.id == 'app'");
  assert.match(identity.run, /OPENKIT_RELEASE_TAG=\$\{GITHUB_REF_NAME\}/u);
  assert.match(identity.run, /OPENKIT_SOURCE_COMMIT=\$\{GITHUB_SHA\}/u);
  assert.equal(
    candidate.with['build-args'],
    actionExpression('steps.release-identity.outputs.args')
  );
  assert.equal(workerBuild.with['build-args'], undefined);
  assert.ok(job.steps.indexOf(identity) < job.steps.indexOf(candidate));
});

test('release workflow smokes one digest on every platform before tag promotion', () => {
  const job = workflow.jobs['publish-container-images'];
  const existing = step(job, 'Inspect existing immutable identity');
  const candidate = step(job, 'Build digest-only release candidate');
  const smoke = step(job, 'Smoke every candidate platform');
  const promote = step(job, 'Promote the smoked digest');
  const verify = step(job, 'Verify promoted identity');
  const anonymous = step(job, 'Verify public worker base anonymous pull');
  const record = step(job, 'Write image release record');

  assert.equal(candidate.with.provenance, false);
  assert.match(candidate.with.outputs, /push-by-digest=true/);
  assert.equal(candidate.with.tags, undefined);
  assert.equal(candidate.if, "steps.existing.outputs.present == 'false'");
  assert.equal(smoke.if, "steps.existing.outputs.present == 'false'");
  assert.deepEqual(smoke.env, {
    DIGEST: actionExpression('steps.release.outputs.digest'),
    IMAGE: actionExpression('steps.image.outputs.image'),
    PLATFORMS: actionExpression('matrix.platforms'),
    SMOKE_COMMAND: actionExpression('matrix.smokeCommand'),
  });
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
  assert.ok(job.steps.indexOf(smoke) < job.steps.indexOf(promote));
  assert.ok(job.steps.indexOf(promote) < job.steps.indexOf(verify));
  assert.equal(anonymous.if, 'matrix.anonymousPull');
  assert.deepEqual(anonymous.env, {
    DIGEST: actionExpression('steps.release.outputs.digest'),
    IMAGE: actionExpression('steps.image.outputs.image'),
  });
  assert.ok(job.steps.indexOf(verify) < job.steps.indexOf(anonymous));
  assert.equal(record.env.ANONYMOUS_PULL, actionExpression('matrix.anonymousPull'));
});

test('candidate smoke runs every platform once against the same digest in a classic image store', () => {
  const { result, runs } = runCandidateSmoke();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(runs, [
    'run linux/amd64 ghcr.io/example/image@sha256:candidate candidate-smoke',
    'run linux/arm64 ghcr.io/example/image@sha256:candidate candidate-smoke',
  ]);
});

test('candidate smoke fails the step when a platform smoke fails', () => {
  const { result, runs } = runCandidateSmoke('linux/amd64');
  assert.equal(result.status, 42, result.stderr);
  assert.match(result.stderr, /smoke failed for linux\/amd64/u);
  assert.deepEqual(runs, [
    'run linux/amd64 ghcr.io/example/image@sha256:candidate candidate-smoke',
  ]);
});

/** Executes the workflow body with a per-reference, single-platform Docker store double. */
function runCandidateSmoke(failPlatform = '') {
  const directory = mkdtempSync(join(tmpdir(), 'openkit-candidate-smoke-'));
  const stateFile = join(directory, 'state.json');
  const logFile = join(directory, 'runs.log');
  try {
    writeFileSync(stateFile, '{}');
    writeFileSync(logFile, '');
    writeFileSync(
      join(directory, 'docker'),
      `#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const state = JSON.parse(readFileSync(process.env.DOCKER_STATE, 'utf8'));
if (args.length === 6 && args[0] === 'run' && args[1] === '--rm' && args[2] === '--platform') {
  const [, , , platform, reference, command] = args;
  if (Object.hasOwn(state, reference) && state[reference] !== platform) {
    console.error('docker: cannot overwrite digest ' + reference.split('@')[1]);
    process.exit(125);
  }
  state[reference] = platform;
  writeFileSync(process.env.DOCKER_STATE, JSON.stringify(state));
  appendFileSync(process.env.DOCKER_LOG, 'run ' + platform + ' ' + reference + ' ' + command + '\\n');
  if (platform === process.env.FAIL_PLATFORM) {
    console.error('smoke failed for ' + platform);
    process.exit(42);
  }
} else if ((args.length === 3 && args[0] === 'image' && args[1] === 'rm') ||
           (args.length === 2 && args[0] === 'rmi')) {
  const reference = args.at(-1);
  if (!Object.hasOwn(state, reference)) {
    console.error('docker: no such image: ' + reference);
    process.exit(1);
  }
  delete state[reference];
  writeFileSync(process.env.DOCKER_STATE, JSON.stringify(state));
} else {
  console.error('unsupported docker arguments: ' + JSON.stringify(args));
  process.exit(1);
}
`,
      { mode: 0o755 }
    );
    const smoke = step(workflow.jobs['publish-container-images'], 'Smoke every candidate platform');
    const result = spawnSync('bash', ['-e', '-c', smoke.run], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        IMAGE: 'ghcr.io/example/image',
        DIGEST: 'sha256:candidate',
        PLATFORMS: 'linux/amd64,linux/arm64',
        SMOKE_COMMAND: 'candidate-smoke',
        DOCKER_STATE: stateFile,
        DOCKER_LOG: logFile,
        FAIL_PLATFORM: failPlatform,
      },
      encoding: 'utf8',
    });
    return { result, runs: readFileSync(logFile, 'utf8').trim().split('\n') };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

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
  assert.equal(smokeJob.needs, 'container-image-matrix');
  assert.deepEqual(
    smokeJob.strategy.matrix,
    actionExpression('fromJSON(needs.container-image-matrix.outputs.worker-matrix)')
  );
  assert.ok(step(smokeJob, 'Set up QEMU').uses);
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
// The App split re-records only the Worker matrix expression and final App dependency edges.
// New App jobs are frozen below; an additional normalization check proves unchanged Worker and final steps.
const unchangedJobBaseline = {
  'container-image-matrix': 'a69e8a2973c459f0b7245dc2e48a249ff20627793611ce1ad7695fd0d2175790',
  'build-app-candidate': '460407c16d03c5d7e417cea439c16d9e2955db7c82cfb5cdbdb260aa9b2da9f9',
  'smoke-app-native': '2038f6417de2a540d8f1ae7e2cba81124fae00d9ebf63cd854b570fc8e82dc5a',
  'publish-app-image': '114be90cfeee7b6cb98ecd80669c80e44ccea8baf9a551c3408b575252ff1b9c',
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
  'publish-container-images': 'c93cf3366e69528e1d77e878b411baa17afcb71c81ab65028e5b742e2a67e959',
  'github-release': 'a958b120359eb1021bca3cc1f339f3eed559fdd35b1bce29e40f8ddbb480e766',
  'verify-release': '40b71518d310e49c1a68ab3bc801f1500d3e813f0f2410017db67329b85896b9',
};

test('publication, packaging and all other jobs match the frozen complete job graph', () => {
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
          !['l0-l2', 'nano-core-e2e', 'app-image-admin-recovery', 'smoke-worker-images'].includes(
            name
          )
      )
      .sort(),
    Object.keys(unchangedJobBaseline).sort()
  );
  for (const [name, digest] of Object.entries(unchangedJobBaseline)) {
    assert.equal(createHash('sha256').update(blocks.get(name)).digest('hex'), digest, name);
  }
});

test('only L0-L2 and NanoCore e2e gain actions read and tag-only reuse directly after checkout', () => {
  const selected = ['l0-l2', 'nano-core-e2e'];
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (!selected.includes(name)) {
      assert.equal(job.permissions?.actions, undefined, name);
      assert.ok(!job.steps?.some((entry) => entry.id === 'reuse'), name);
      continue;
    }
    assert.deepEqual(job.permissions, { contents: 'read', packages: 'read', actions: 'read' });
    assert.equal(job.needs, 'test-image');
    assert.equal(job.container.image, actionExpression('needs.test-image.outputs.image'));
    assert.equal(job.steps[0].name, 'Checkout');
    const reuse = job.steps[1];
    assert.equal(reuse.id, 'reuse');
    assert.equal(reuse.if, "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/')");
    assert.deepEqual(reuse.env, {
      GITHUB_TOKEN: actionExpression('secrets.GITHUB_TOKEN'),
      REUSE_JOB_NAME: job.name,
    });
    assert.match(reuse.run, /node scripts\/release-ci-reuse\.mjs/u);
    assert.match(reuse.run, /--repository "\$\{GITHUB_REPOSITORY\}"/u);
    assert.match(reuse.run, /--workflow ci\.yml/u);
    assert.match(reuse.run, /--sha "\$\{GITHUB_SHA\}"/u);
    assert.match(reuse.run, /--job "\$\{REUSE_JOB_NAME\}"/u);
    for (const later of job.steps.slice(2)) {
      assert.equal(later.if, "steps.reuse.outputs.reused != 'true'", later.name);
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
    for (const name of ['l0-l2', 'nano-core-e2e']) {
      const reuse = step(workflow.jobs[name], 'Reuse exact-commit candidate job');
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
      `return (${workflow.jobs[id].if});`
    )(
      { event_name: event, ref },
      { gate },
      (values, value) => values.includes(value),
      JSON.parse,
      (value, prefix) => value.startsWith(prefix)
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
  assert.equal(jobRuns('web-e2e', 'push', 'refs/heads/main'), false);
});

test('L0-L2 uses the admitted single coverage execution while keeping native and root tests', () => {
  const command = step(
    workflow.jobs['l0-l2'],
    'Run L0-L2 verification as the unprivileged image user'
  );
  assert.match(command.run, /pnpm -w verify:l0-l2/u);
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
  assert.match(scripts['verify:l0-l2'], /pnpm run test:ci/u);
  assert.doesNotMatch(scripts['verify:l0-l2'], /test:unit|test:coverage/u);
  assert.match(scripts['test:ci'], /release-tests\.mjs/u);
});

test('App publication waits for exact-manifest smoke on both native hosts', () => {
  const build = workflow.jobs['build-app-candidate'];
  const native = workflow.jobs['smoke-app-native'];
  const publish = workflow.jobs['publish-app-image'];
  assert.ok(build, 'tag-stage App candidate build is required');
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

test('Worker publication and final verification keep every existing step byte', () => {
  const blocks = new Map(
    [
      ...workflowBytes
        .slice(workflowBytes.indexOf('jobs:\n') + 6)
        .matchAll(/^ {2}([a-z0-9-]+):\n(.*?)(?=^ {2}[a-z0-9-]+:\n|(?![\s\S]))/gms),
    ].map((match) => [match[1], match[2]])
  );
  const old = {
    'publish-container-images': 'd354fc4bdb01687274e33f475445833d56a1970f18fc3e8c585c4b4b8086c38a',
    'github-release': '342e687fc7bcb4773a791cc7d8925fb4bab7306f4cabade9513ac69238407cfd',
    'verify-release': '20c614ff0f1300b403789cfb9145f5ca26fdfa2f5482d7a3089f0682681b5c9f',
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
