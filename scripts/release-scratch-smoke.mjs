#!/usr/bin/env node
/** Observe only the published scratch amd64 fixture; keep control C separate from subject P. */
import { spawnSync } from 'node:child_process';
import {
  openSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { command, commitAt, githubJson, observePublication } from './release-observe.mjs';
import { canonical, sha, noSecrets } from './release-safety.mjs';

export const scratchRepository = 'notrucked/openkit';
export const smokeJob = 'Published scratch amd64 retained-read smoke';
export const smokeWorkflow = '.github/workflows/release-scratch-smoke.yml';
const revision = /^[a-f0-9]{40}$/;
const digest = /^sha256:[a-f0-9]{64}$/;
const hash = /^[a-f0-9]{64}$/;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const check = (condition, message) => {
  if (!condition) throw Error(message);
};
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const save = (file, value) =>
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });

/** Admit only the named repository and exact reviewed dispatch source before using package access. */
export function validateDispatch(context) {
  check(
    context.repository === scratchRepository &&
      context.event === 'workflow_dispatch' &&
      context.fork === false &&
      revision.test(context.control) &&
      context.workflowSource === context.control &&
      context.source === context.control &&
      context.ref === `refs/heads/scratch/cadence-smoke/${context.control}` &&
      Number.isSafeInteger(context.runId) &&
      context.runId > 0 &&
      Number.isSafeInteger(context.attempt) &&
      context.attempt > 0,
    'Reviewed scratch-only dispatch required'
  );
  return context;
}

/** Public subject selection contains no target, script, credential or image-reference input. */
export function validateSubject(subject) {
  check(
    subject.repository === scratchRepository &&
      /^v\d+\.\d+\.\d+-[a-z0-9][a-z0-9.-]*$/.test(subject.tag ?? '') &&
      revision.test(subject.sha ?? '') &&
      Number.isSafeInteger(subject.runId) &&
      subject.runId > 0,
    'Published scratch prerelease required'
  );
  return subject;
}

/** Rebuild the fixture environment from public process requirements, never inherited authentication. */
export function fixtureEnvironment(directory, target) {
  return {
    PATH: process.env.PATH,
    HOME: join(directory, 'home'),
    XDG_CONFIG_HOME: join(directory, 'home', '.config'),
    TMPDIR: directory,
    LANG: 'C.UTF-8',
    ...(target ? { OPENKIT_NANOCORE_URL: target } : {}),
  };
}

/** Select immutable API provenance; download ZIP bytes before interpreting any contained result. */
export function artifactFile(
  { runId, source, name, filename, attemptStartedAt, entries: expectedEntries = [filename] },
  { read = githubJson, run = command, download = downloadZip } = {}
) {
  const pages = read(`repos/${scratchRepository}/actions/runs/${runId}/artifacts?per_page=100`, {
    paginate: true,
  });
  check(
    Array.isArray(pages) && pages.every((p) => Array.isArray(p.artifacts)),
    'Complete artifact pages required'
  );
  const artifacts = pages.flatMap((p) => p.artifacts);
  const found = artifacts.filter((a) => a.name === name);
  check(
    pages.every((p) => p.total_count === artifacts.length) && found.length === 1,
    'Unique artifact required'
  );
  const artifact = found[0];
  check(
    Number.isSafeInteger(artifact.id) &&
      artifact.id > 0 &&
      artifact.expired === false &&
      digest.test(artifact.digest ?? '') &&
      artifact.workflow_run?.id === runId &&
      artifact.workflow_run.head_sha === source &&
      Date.parse(artifact.created_at) >= Date.parse(attemptStartedAt),
    'Current immutable source artifact required'
  );
  const directory = mkdtempSync(join(tmpdir(), 'openkit-scratch-artifact-'));
  try {
    const zip = join(directory, 'artifact.zip');
    download(artifact.id, zip);
    check(
      `sha256:${sha(readFileSync(zip))}` === artifact.digest,
      'API artifact ZIP digest differs'
    );
    const entries = run('unzip', ['-Z1', zip]).split('\n');
    check(
      canonical(entries.slice().sort()) === canonical(expectedEntries.slice().sort()),
      'Unexpected artifact entries'
    );
    const bytes = run('unzip', ['-p', zip, filename]);
    const current = read(`repos/${scratchRepository}/actions/artifacts/${artifact.id}`);
    check(
      current.id === artifact.id &&
        current.digest === artifact.digest &&
        current.expired === false &&
        current.workflow_run?.id === runId &&
        current.workflow_run.head_sha === source,
      'Artifact identity changed during download'
    );
    return {
      record: JSON.parse(bytes),
      artifact: { id: artifact.id, digest: artifact.digest, name: artifact.name },
      recordSha256: sha(bytes),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** GitHub follows its authenticated artifact redirect; no signed URL or authorization enters output. */
function downloadZip(id, file) {
  const fd = openSync(file, 'wx', 0o600);
  try {
    const result = spawnSync(
      'gh',
      ['api', `repos/${scratchRepository}/actions/artifacts/${id}/zip`],
      { stdio: ['ignore', fd, 'pipe'], timeout: 120000 }
    );
    check(!result.error && result.status === 0, 'Artifact ZIP download failed');
  } finally {
    closeSync(fd);
  }
}

/** Observe a successful current publication and its actual source artifacts, not supplied outcome fields. */
export function publishedSubject(subject) {
  validateSubject(subject);
  const proof = observePublication({ ...subject });
  const metadata = githubJson(`repos/${scratchRepository}/actions/runs/${subject.runId}`);
  const release = githubJson(`repos/${scratchRepository}/releases/tags/${subject.tag}`);
  check(
    release.draft === false && release.prerelease === true && release.tag_name === subject.tag,
    'Published prerelease identity required'
  );
  const asset = (name) => {
    const matches = release.assets.filter((a) => a.name === name);
    check(
      matches.length === 1 &&
        Number.isSafeInteger(matches[0].id) &&
        digest.test(matches[0].digest ?? ''),
      'Immutable published asset required'
    );
    return { id: matches[0].id, name, digest: matches[0].digest };
  };
  const cli = asset(`openkit-ops-skill-${subject.tag}.tar.gz`),
    checksums = asset('SHA256SUMS');
  const image = artifactFile({
    runId: subject.runId,
    source: subject.sha,
    name: 'release-image-app',
    filename: 'app.json',
    entries: ['app.json', 'app.md'],
    attemptStartedAt: metadata.run_started_at,
  }).record;
  const platforms = image.platforms?.filter((p) => p.platform === 'linux/amd64');
  check(
    image.id === 'app' &&
      image.prerelease === true &&
      image.image === 'ghcr.io/notrucked/openkit-app' &&
      digest.test(image.digest ?? '') &&
      platforms?.length === 1 &&
      digest.test(platforms[0].digest) &&
      image.tags?.includes(`${image.image}:${subject.tag}`),
    'Published amd64 App identity required'
  );
  return {
    ...subject,
    attempt: proof.attempt,
    releaseId: release.id,
    cli,
    checksums,
    image,
    manifestDigest: platforms[0].digest,
  };
}

/** Observe the control workflow and its current job separately from the published subject. */
export function observeSmoke(control, runId, { complete = true, read = githubJson } = {}) {
  const run = read(`repos/${scratchRepository}/actions/runs/${runId}`);
  validateDispatch({
    repository: run.repository?.full_name,
    event: run.event,
    fork: run.repository?.fork,
    control,
    workflowSource: control,
    source: run.head_sha,
    ref: `refs/heads/${run.head_branch}`,
    runId: run.id,
    attempt: run.run_attempt,
  });
  check(
    run.id === runId &&
      run.path === smokeWorkflow &&
      (!complete || (run.status === 'completed' && run.conclusion === 'success')),
    'Successful reviewed smoke workflow required'
  );
  const pages = read(
    `repos/${scratchRepository}/actions/runs/${runId}/attempts/${run.run_attempt}/jobs?per_page=100`,
    { paginate: true }
  );
  check(
    Array.isArray(pages) && pages.every((p) => Array.isArray(p.jobs)),
    'Complete smoke job pages required'
  );
  const jobs = pages.flatMap((p) => p.jobs),
    matches = jobs.filter((j) => j.name === smokeJob);
  check(
    pages.every((p) => p.total_count === jobs.length) && matches.length === 1,
    'Unique smoke job required'
  );
  const job = matches[0];
  check(
    job.run_attempt === run.run_attempt &&
      Number.isSafeInteger(job.id) &&
      job.id > 0 &&
      (!complete ||
        (job.status === 'completed' &&
          job.conclusion === 'success' &&
          [
            'Prepare published inputs',
            'Run credential-isolated fixture',
            'Confirm attempt cleanup',
            'Upload selected result',
          ].every(
            (name) =>
              job.steps.filter((s) => s.name === name && s.conclusion === 'success').length === 1
          ))),
    'Complete current smoke attempt required'
  );
  return {
    runId,
    attempt: run.run_attempt,
    jobId: job.id,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    attemptStartedAt: run.run_started_at,
  };
}

/** Only explicitly passed GitHub-created token is used, and registry authentication is destroyed after pull. */
export function prepare({ subject, control, directory }) {
  const start = new Date().toISOString();
  const event = json(process.env.GITHUB_EVENT_PATH);
  const context = validateDispatch({
    repository: process.env.GITHUB_REPOSITORY,
    event: process.env.GITHUB_EVENT_NAME,
    fork: event.repository?.fork,
    control,
    source: process.env.GITHUB_SHA,
    workflowSource: process.env.GITHUB_WORKFLOW_SHA,
    ref: process.env.GITHUB_REF,
    runId: Number(process.env.GITHUB_RUN_ID),
    attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  });
  check(
    commitAt('HEAD', { cwd: root }) === control &&
      process.env.GITHUB_JOB === 'scratch-smoke' &&
      process.env.GH_TOKEN,
    'Reviewed CI control and job token required'
  );
  mkdirSync(directory, { mode: 0o700 });
  const published = publishedSubject(subject),
    smoke = observeSmoke(control, context.runId, { complete: false });
  const assets = join(directory, 'published');
  command('gh', [
    'release',
    'download',
    subject.tag,
    '--repo',
    scratchRepository,
    '--pattern',
    published.cli.name,
    '--pattern',
    'SHA256SUMS',
    '--dir',
    assets,
  ]);
  check(
    `sha256:${sha(readFileSync(join(assets, published.cli.name)))}` === published.cli.digest &&
      `sha256:${sha(readFileSync(join(assets, 'SHA256SUMS')))}` === published.checksums.digest,
    'Published asset API digest differs'
  );
  check(
    readFileSync(join(assets, 'SHA256SUMS'), 'utf8')
      .trim()
      .split('\n')
      .includes(`${published.cli.digest.slice(7)}  ${published.cli.name}`),
    'Published CLI checksum differs'
  );
  save(join(assets, 'app.json'), published.image);
  const auth = mkdtempSync(join(tmpdir(), 'openkit-scratch-registry-'));
  let imageId, configDigest;
  try {
    const env = { ...fixtureEnvironment(directory), DOCKER_CONFIG: auth };
    const docker = (args) =>
      command('docker', ['--host', 'unix:///var/run/docker.sock', ...args], {
        env,
        timeout: 300000,
      });
    command(
      'docker',
      [
        '--config',
        auth,
        'login',
        'ghcr.io',
        '--username',
        process.env.GITHUB_ACTOR,
        '--password-stdin',
      ],
      { input: process.env.GH_TOKEN, env }
    );
    const reference = `${published.image.image}@${published.image.digest}`;
    const index = JSON.parse(docker(['buildx', 'imagetools', 'inspect', '--raw', reference]));
    check(
      index.manifests?.filter(
        (m) =>
          m.platform?.os === 'linux' &&
          m.platform.architecture === 'amd64' &&
          m.digest === published.manifestDigest
      ).length === 1,
      'Published amd64 manifest differs'
    );
    const manifest = JSON.parse(
      docker([
        'buildx',
        'imagetools',
        'inspect',
        '--raw',
        `${published.image.image}@${published.manifestDigest}`,
      ])
    );
    configDigest = manifest.config?.digest;
    check(digest.test(configDigest ?? ''), 'Published image config required');
    docker(['pull', '--platform', 'linux/amd64', reference]);
    imageId = docker(['image', 'inspect', '--format', '{{.Id}}', reference]);
    check(imageId === configDigest, 'Pulled image differs from published config');
  } finally {
    rmSync(auth, { recursive: true, force: true });
  }
  const prepared = {
    schemaVersion: 1,
    subject: published,
    control,
    smoke,
    imageId,
    configDigest,
    prepareStartedAt: start,
    preparedAt: new Date().toISOString(),
  };
  save(join(directory, 'prepared.json'), prepared);
  return prepared;
}

/** Derive only attempt-owned resource names; no target or deletion scope comes from workflow inputs. */
export function resources(directory, smoke) {
  const nonce = `${smoke.runId}-${smoke.attempt}`;
  check(/^\d+-\d+$/.test(nonce), 'Attempt resource identity required');
  return {
    nonce,
    container: `openkit-cadence-${nonce}`,
    volume: `openkit-cadence-${nonce}-data`,
    directory,
    result: `${directory}-result/result.json`,
  };
}

/** Remove only labelled resources with this exact attempt identity; preserve independent cleanup failures. */
export function cleanupFixture(
  owned,
  docker = (args) =>
    command('docker', ['--host', 'unix:///var/run/docker.sock', ...args], {
      env: fixtureEnvironment(owned.directory),
    })
) {
  const result = {
    containerRemoved: false,
    volumeRemoved: false,
    temporaryRemoved: false,
    errors: [],
  };
  for (const [kind, name, field] of [
    ['container', owned.container, 'containerRemoved'],
    ['volume', owned.volume, 'volumeRemoved'],
  ]) {
    try {
      const names = docker(
        kind === 'container'
          ? ['container', 'ls', '--all', '--format', '{{.Names}}']
          : ['volume', 'ls', '--format', '{{.Name}}']
      ).split('\n');
      if (names.includes(name)) {
        const label = docker([
          kind,
          'inspect',
          '--format',
          kind === 'container'
            ? '{{index .Config.Labels "openkit.cadence-fixture"}}'
            : '{{index .Labels "openkit.cadence-fixture"}}',
          name,
        ]);
        check(label === owned.nonce, 'Foreign cleanup resource refused');
        docker(
          kind === 'container' ? ['container', 'rm', '--force', name] : ['volume', 'rm', name]
        );
      }
      const remaining = docker(
        kind === 'container'
          ? ['container', 'ls', '--all', '--format', '{{.Names}}']
          : ['volume', 'ls', '--format', '{{.Name}}']
      ).split('\n');
      check(!remaining.includes(name), 'Fixture resource remains');
      result[field] = true;
    } catch {
      result.errors.push(`${kind}-cleanup-failed`);
    }
  }
  try {
    rmSync(owned.directory, { recursive: true, force: true });
    result.temporaryRemoved = !existsSync(owned.directory);
  } catch {
    result.errors.push('temporary-cleanup-failed');
  }
  result.success =
    result.containerRemoved &&
    result.volumeRemoved &&
    result.temporaryRemoved &&
    result.errors.length === 0;
  return result;
}

/** Readiness remains a bounded observation, including the deliberately non-ready harness target. */
export async function waitReady(
  target,
  { fetcher = fetch, milliseconds = 60000, interval = 1000 } = {}
) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    try {
      const response = await fetcher(`${target}/api/health`, {
        signal: AbortSignal.timeout(Math.min(1000, milliseconds)),
      });
      if (response.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, interval));
  }
  throw Error('Fixture readiness timeout');
}

/** Run P's existing verifier with staged downloads; every product operation still uses the real published CLI. */
export async function fixture(
  { directory, subjectRoot },
  {
    run = command,
    ready = waitReady,
    load = async () => import(pathToFileURL(join(subjectRoot, 'scripts/release-post-smoke.mjs'))),
    cleanup = cleanupFixture,
    verifySkill,
  } = {}
) {
  const prepared = json(join(directory, 'prepared.json')),
    { subject, control, smoke } = prepared;
  validateSubject(subject);
  check(
    commitAt('HEAD', { cwd: subjectRoot }) === subject.sha &&
      commitAt('HEAD', { cwd: root }) === control &&
      process.platform === 'linux' &&
      process.arch === 'x64' &&
      Number(process.versions.node.split('.')[0]) === 24,
    'Separate reviewed P and amd64 control required'
  );
  const owned = resources(directory, smoke),
    env = fixtureEnvironment(directory);
  mkdirSync(env.HOME, { recursive: true, mode: 0o700 });
  const docker = (args) =>
    run('docker', ['--host', 'unix:///var/run/docker.sock', ...args], { env, timeout: 30000 });
  const record = {
    schemaVersion: 1,
    repository: scratchRepository,
    tag: subject.tag,
    sha: subject.sha,
    control,
    publication: { runId: subject.runId, attempt: subject.attempt, releaseId: subject.releaseId },
    smoke,
    cli: subject.cli,
    checksums: subject.checksums,
    image: {
      indexDigest: subject.image.digest,
      manifestDigest: subject.manifestDigest,
      imageId: prepared.imageId,
      configDigest: prepared.configDigest,
      platform: 'linux/amd64',
    },
    prepareStartedAt: prepared.prepareStartedAt,
    preparedAt: prepared.preparedAt,
    startedAt: new Date().toISOString(),
    outcome: 'failed',
  };
  let stage = 'create';
  try {
    check(
      !docker(['container', 'ls', '--all', '--format', '{{.Names}}'])
        .split('\n')
        .includes(owned.container) &&
        !docker(['volume', 'ls', '--format', '{{.Name}}']).split('\n').includes(owned.volume),
      'Existing attempt fixture refused'
    );
    docker(['volume', 'create', '--label', `openkit.cadence-fixture=${owned.nonce}`, owned.volume]);
    docker([
      'run',
      '--detach',
      '--name',
      owned.container,
      '--label',
      `openkit.cadence-fixture=${owned.nonce}`,
      '--publish',
      '127.0.0.1::8080',
      '--mount',
      `type=volume,source=${owned.volume},target=/data/openkit`,
      `${subject.image.image}@${subject.image.digest}`,
    ]);
    const state = () => {
      const observed = JSON.parse(docker(['container', 'inspect', owned.container]))[0];
      const mount = observed.Mounts.filter((m) => m.Destination === '/data/openkit');
      check(
        mount.length === 1 && mount[0].Name === owned.volume && mount[0].Type === 'volume',
        'Attempt Data Root differs'
      );
      return {
        containerId: observed.Id,
        imageId: observed.Image,
        dataRoot: mount[0].Name,
        running: observed.State.Running,
        processId: observed.State.Pid,
        startedAt: observed.State.StartedAt,
        finishedAt: observed.State.FinishedAt,
        ports: observed.NetworkSettings.Ports,
      };
    };
    const helper = await load();
    const before = state(),
      target = helper.verifyLocalBinding(
        `http://127.0.0.1:${before.ports['8080/tcp'][0].HostPort}`,
        before
      );
    stage = 'readiness-before';
    await ready(target);
    const skill =
      verifySkill ??
      (await import(pathToFileURL(join(subjectRoot, 'scripts/package-release-assets.mjs'))))
        .verifyOperationsSkillArchive;
    const { cliPath } = skill({
      archivePath: join(directory, 'published', subject.cli.name),
      destDir: join(directory, 'operations'),
    });
    const cli = (operation, input) => {
      const result = JSON.parse(
        run(process.execPath, [cliPath, 'ops', 'call', operation, '--input', '-'], {
          env: fixtureEnvironment(directory, target),
          input: JSON.stringify(input),
          timeout: 30000,
        })
      );
      check(
        result.ok === true && result.operation === operation,
        'Fixture public operation failed'
      );
      return result.data;
    };
    stage = 'create-workspace';
    const name = `Cadence scratch ${owned.nonce}`;
    const created = cli('workspace.create', { requestId: crypto.randomUUID(), name });
    check(
      typeof created.id === 'string' && created.name === name,
      'Synthetic Workspace creation differs'
    );
    const input = { workspaceId: created.id };
    stage = 'read-before';
    const prior = cli('workspace.read', input);
    check(prior.id === created.id && prior.name === name, 'Stored synthetic Workspace differs');
    record.read = {
      operation: 'workspace.read',
      input,
      fixtureName: name,
      canonicalization: 'canonical-json-v1',
      beforeSha256: sha(canonical(prior)),
      beforeReadAt: new Date().toISOString(),
    };
    // Retain this immutable expected hash before the restart. Never recompute it from the new process.
    save(join(directory, 'prior-read.json'), record.read);
    record.restart = { before: state() };
    stage = 'stop';
    docker(['stop', '--time', '15', owned.container]);
    record.restart.stopped = state();
    record.restart.stoppedAt = new Date().toISOString();
    check(record.restart.stopped.running === false, 'App did not stop');
    stage = 'start';
    docker(['start', owned.container]);
    record.restart.after = state();
    record.restart.restartedAt = new Date().toISOString();
    check(
      record.restart.after.startedAt !== record.restart.before.startedAt &&
        record.restart.after.running === true,
      'New App process was not observed'
    );
    stage = 'readiness-after';
    await ready(target);
    const staged = (executable, args, options = {}) => {
      if (executable === 'gh') {
        const expected =
          args[0] === 'release'
            ? [
                'release',
                'download',
                subject.tag,
                '--repo',
                scratchRepository,
                '--pattern',
                subject.cli.name,
                '--pattern',
                'SHA256SUMS',
                '--dir',
              ]
            : [
                'run',
                'download',
                String(subject.runId),
                '--repo',
                scratchRepository,
                '--name',
                'release-image-app',
                '--dir',
              ];
        check(
          canonical(args.slice(0, -1)) === canonical(expected),
          'Unreviewed staged download refused'
        );
        const destination = args.at(-1);
        mkdirSync(destination, { recursive: true });
        for (const file of args[0] === 'release' ? [subject.cli.name, 'SHA256SUMS'] : ['app.json'])
          writeFileSync(join(destination, file), readFileSync(join(directory, 'published', file)));
        return '';
      }
      return run(executable, args, {
        ...options,
        cwd: subjectRoot,
        env: {
          ...fixtureEnvironment(directory, target),
          DOCKER_HOST: 'unix:///var/run/docker.sock',
        },
      });
    };
    stage = 'post-restart-smoke';
    const result = helper.postPublicationSmoke(
      {
        target,
        params: {
          repository: scratchRepository,
          tag: subject.tag,
          sha: subject.sha,
          runId: subject.runId,
          container: owned.container,
          reads: [{ operation: record.read.operation, input, sha256: record.read.beforeSha256 }],
        },
        output: join(directory, 'post-smoke'),
      },
      {
        run: staged,
        publication: (params) => {
          check(
            params.repository === scratchRepository &&
              params.sha === subject.sha &&
              params.tag === subject.tag &&
              params.runId === subject.runId,
            'Prepared publication binding differs'
          );
          return prepared.subject;
        },
      }
    );
    check(
      result.outcome === 'passed' && result.identities.imageId === prepared.configDigest,
      'Published post-restart identity differs'
    );
    record.read.afterSha256 = result.reads[0].sha256;
    record.read.afterReadAt = result.end;
    record.image.reportedSource = subject.sha;
    record.image.reportedTag = subject.tag;
    record.outcome = 'passed';
  } catch {
    record.failureStage = stage;
  } finally {
    record.cleanup = { initial: cleanup(owned, docker) };
    record.endedAt = new Date().toISOString();
    mkdirSync(dirname(owned.result), { recursive: true, mode: 0o700 });
    save(owned.result, record);
  }
  return record;
}

/** Reject false passes, missing restarts, changed reads or cleanup without relying on producer prose. */
export function validateResult(
  record,
  { subject, control, smoke, notBefore, validUntil, now = new Date() }
) {
  validateSubject(subject);
  noSecrets(record);
  check(revision.test(control), 'Reviewed control revision required');
  const allowed = [
    'schemaVersion',
    'repository',
    'tag',
    'sha',
    'control',
    'publication',
    'smoke',
    'cli',
    'checksums',
    'image',
    'prepareStartedAt',
    'preparedAt',
    'startedAt',
    'outcome',
    'read',
    'restart',
    'cleanup',
    'endedAt',
  ];
  check(
    canonical(Object.keys(record ?? {}).sort()) === canonical(allowed.sort()),
    'Only selected non-secret result fields are admitted'
  );
  const goodCleanup = (c) =>
    c?.success === true &&
    c.containerRemoved === true &&
    c.volumeRemoved === true &&
    c.temporaryRemoved === true &&
    Array.isArray(c.errors) &&
    c.errors.length === 0;
  check(
    record?.schemaVersion === 1 &&
      record.repository === scratchRepository &&
      record.sha === subject.sha &&
      record.tag === subject.tag &&
      record.control === control &&
      record.publication?.runId === subject.runId &&
      record.publication.attempt === subject.attempt &&
      record.publication.releaseId === subject.releaseId &&
      record.smoke?.runId === smoke.runId &&
      record.smoke.attempt === smoke.attempt &&
      record.smoke.jobId === smoke.jobId &&
      record.outcome === 'passed',
    'Exact successful subject and control bindings required'
  );
  check(
    canonical(record.cli) === canonical(subject.cli) &&
      canonical(record.checksums) === canonical(subject.checksums) &&
      record.image?.platform === 'linux/amd64' &&
      record.image.indexDigest === subject.image.digest &&
      record.image.manifestDigest === subject.manifestDigest &&
      digest.test(record.image.imageId ?? '') &&
      record.image.imageId === record.image.configDigest &&
      record.image.reportedSource === subject.sha &&
      record.image.reportedTag === subject.tag,
    'Published image and CLI bindings differ'
  );
  const before = record.restart?.before,
    stopped = record.restart?.stopped,
    after = record.restart?.after;
  check(
    before?.running === true &&
      stopped?.running === false &&
      after?.running === true &&
      digest.test(before.imageId ?? '') &&
      before.imageId === record.image.imageId &&
      after.imageId === before.imageId &&
      stopped.imageId === before.imageId &&
      before.containerId === after.containerId &&
      before.containerId === stopped.containerId &&
      /^[a-f0-9]{64}$/.test(before.containerId ?? '') &&
      before.dataRoot === `openkit-cadence-${smoke.runId}-${smoke.attempt}-data` &&
      before.dataRoot === after.dataRoot &&
      before.dataRoot === stopped.dataRoot &&
      Number.isSafeInteger(before.processId) &&
      before.processId > 0 &&
      after.processId > 0 &&
      before.processId !== after.processId &&
      Date.parse(after.startedAt) > Date.parse(stopped.finishedAt) &&
      Date.parse(stopped.finishedAt) >= Date.parse(before.startedAt),
    'Observed normal App restart required'
  );
  check(
    record.read?.operation === 'workspace.read' &&
      canonical(Object.keys(record.read.input ?? {})) === canonical(['workspaceId']) &&
      typeof record.read.input.workspaceId === 'string' &&
      record.read.input.workspaceId.length > 0 &&
      record.read.fixtureName === `Cadence scratch ${smoke.runId}-${smoke.attempt}` &&
      record.read.canonicalization === 'canonical-json-v1' &&
      hash.test(record.read.beforeSha256 ?? '') &&
      record.read.afterSha256 === record.read.beforeSha256,
    'Unchanged fixed synthetic Workspace read required'
  );
  check(
    goodCleanup(record.cleanup?.initial) && goodCleanup(record.cleanup?.final),
    'Fixture cleanup is unresolved'
  );
  const times = [
    record.prepareStartedAt,
    record.preparedAt,
    record.startedAt,
    record.read.beforeReadAt,
    record.restart.stoppedAt,
    record.restart.restartedAt,
    record.read.afterReadAt,
    record.endedAt,
  ].map(Date.parse);
  check(
    Number.isFinite(Date.parse(notBefore)) &&
      Number.isFinite(Date.parse(validUntil)) &&
      times.every(Number.isFinite) &&
      times.every((t, i) => i === 0 || t >= times[i - 1]) &&
      times[0] >= Date.parse(notBefore) &&
      times[0] >= Date.parse(smoke.startedAt) &&
      times.at(-1) <= Date.parse(smoke.completedAt) &&
      times.at(-1) <= now.getTime() &&
      now.getTime() < Date.parse(validUntil),
    'Current actual fixture observation window required'
  );
  return record;
}

/** Local acceptance reads only repository APIs and verifies the API ZIP digest before the JSON. */
export function verify(
  { subject, control, runId, notBefore, validUntil },
  {
    commit = commitAt,
    published = publishedSubject,
    observe = observeSmoke,
    artifact = artifactFile,
  } = {}
) {
  validateSubject(subject);
  check(commit('HEAD') === control, 'Use the exact reviewed control checkout');
  const publication = published(subject),
    smoke = observe(control, runId);
  const result = artifact({
    runId,
    source: control,
    name: `scratch-post-smoke-${smoke.attempt}`,
    filename: 'result.json',
    attemptStartedAt: smoke.attemptStartedAt,
  });
  validateResult(result.record, { subject: publication, control, smoke, notBefore, validUntil });
  check(
    canonical(observe(control, runId)) === canonical(smoke) &&
      canonical(published(subject)) === canonical(publication),
    'Publication or smoke attempt changed'
  );
  validateResult(result.record, { subject: publication, control, smoke, notBefore, validUntil });
  return {
    outcome: 'passed',
    subject,
    control,
    smoke,
    ...result,
    verifiedAt: new Date().toISOString(),
    scope: 'scratch-host-independent-amd64-selected-workspace-normal-restart',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { positionals, values } = parseArgs({
      allowPositionals: true,
      options: {
        tag: { type: 'string' },
        source: { type: 'string' },
        publication: { type: 'string' },
        control: { type: 'string' },
        directory: { type: 'string' },
        subject: { type: 'string' },
        run: { type: 'string' },
        'not-before': { type: 'string' },
        'valid-until': { type: 'string' },
        output: { type: 'string' },
      },
    });
    const [action] = positionals;
    const subject = {
      repository: scratchRepository,
      tag: values.tag,
      sha: values.source,
      runId: Number(values.publication),
    };
    let result;
    if (action === 'prepare')
      result = prepare({ subject, control: values.control, directory: resolve(values.directory) });
    else if (action === 'fixture')
      result = await fixture({
        directory: resolve(values.directory),
        subjectRoot: resolve(values.subject),
      });
    else if (action === 'cleanup') {
      const owned = resources(resolve(values.directory), {
        runId: Number(process.env.GITHUB_RUN_ID),
        attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      });
      const previous = existsSync(owned.result)
        ? json(owned.result)
        : { outcome: 'failed', failureStage: 'missing-fixture-result', cleanup: {} };
      previous.cleanup ??= {};
      previous.cleanup.final = cleanupFixture(owned);
      previous.endedAt = new Date().toISOString();
      mkdirSync(dirname(owned.result), { recursive: true, mode: 0o700 });
      save(owned.result, previous);
      result = previous;
    } else if (action === 'verify') {
      result = verify({
        subject,
        control: values.control,
        runId: Number(values.run),
        notBefore: values['not-before'],
        validUntil: values['valid-until'],
      });
      check(values.output, 'Explicit verification output required');
      save(values.output, result);
    } else throw Error('Expected prepare, fixture, cleanup or verify');
    if (action !== 'prepare')
      check(
        result.outcome === 'passed' &&
          (action !== 'fixture' || result.cleanup.initial.success) &&
          (action !== 'cleanup' || result.cleanup.final.success),
        'Fixture or cleanup failed; inspect selected result'
      );
    console.log(
      JSON.stringify({ action, outcome: action === 'prepare' ? 'prepared' : result.outcome })
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
