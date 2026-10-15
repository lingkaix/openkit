#!/usr/bin/env node
/** Tag-stage App evidence: one index, two native exact-manifest smokes, then promotion. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const platforms = ['linux/amd64', 'linux/arm64'];
const digestPattern = /^sha256:[a-f0-9]{64}$/;
/** Refuse incomplete or conflicting observations before any publication effect. */
function requireFact(value, message) {
  if (!value) throw Error(`App native evidence refused: ${message}`);
}
/** Run one required command; command errors are never evidence of product refusal. */
function command(program, args, options = {}) {
  const r = spawnSync(program, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
  requireFact(!r.error && !r.signal && r.status === 0, `${program} failed: ${r.stderr ?? ''}`);
  return r.stdout?.trim() ?? '';
}
/** Read the immutable workflow-run identity from the job, never from downloaded evidence. */
function identity() {
  const e = process.env;
  requireFact(/^[a-f0-9]{40}$/.test(e.GITHUB_SHA ?? ''), 'source revision');
  requireFact(
    /^refs\/tags\/v/.test(e.GITHUB_REF ?? '') && e.GITHUB_EVENT_NAME === 'push',
    'tag push'
  );
  requireFact(
    /^\d+$/.test(e.GITHUB_RUN_ID ?? '') && /^\d+$/.test(e.GITHUB_RUN_ATTEMPT ?? ''),
    'run identity'
  );
  return {
    repository: e.GITHUB_REPOSITORY,
    source: e.GITHUB_SHA,
    tag: e.GITHUB_REF_NAME,
    runId: e.GITHUB_RUN_ID,
    attempt: e.GITHUB_RUN_ATTEMPT,
  };
}
/** Check all architecture facts outside the image, including the selected Docker endpoint. */
export function verifyNativeHost(platform, host) {
  const arm = platform === 'linux/arm64';
  requireFact(
    platforms.includes(platform) &&
      host?.system === 'Linux' &&
      host.kernel === (arm ? 'aarch64' : 'x86_64') &&
      host.node === (arm ? 'arm64' : 'x64') &&
      host.runner === (arm ? 'ARM64' : 'X64') &&
      [platform, `linux/${arm ? 'aarch64' : 'x86_64'}`].includes(host.docker) &&
      host.endpoint === 'unix:///var/run/docker.sock',
    'native host architecture or Docker endpoint mismatch'
  );
}
/** Inspect the index addressed by digest and resolve exactly the declared App platforms. */
function indexPlatforms(image, digest) {
  requireFact(digestPattern.test(digest ?? ''), 'index digest');
  const index = JSON.parse(
    command('docker', ['buildx', 'imagetools', 'inspect', '--raw', `${image}@${digest}`])
  );
  requireFact(
    Array.isArray(index.manifests) && index.manifests.length === platforms.length,
    'index platform set'
  );
  return platforms.map((platform) => {
    const [os, architecture] = platform.split('/');
    const found = index.manifests.filter(
      (m) => m.platform?.os === os && m.platform?.architecture === architecture
    );
    requireFact(
      found.length === 1 && digestPattern.test(found[0].digest),
      `index manifest ${platform}`
    );
    return { platform, digest: found[0].digest };
  });
}
/** Bind a candidate or observation to this tag run and to the declared App catalog. */
function validateCandidate(c) {
  for (const [key, value] of Object.entries(identity()))
    requireFact(c[key] === value, `candidate ${key}`);
  const manifest = JSON.parse(
    readFileSync(new URL('../containers/images.json', import.meta.url), 'utf8')
  );
  const app = manifest.images.find((image) => image.id === 'app');
  requireFact(
    app?.release === true && app.platforms.slice().sort().join(',') === platforms.join(','),
    'App catalog platforms'
  );
  requireFact(
    c.image === `ghcr.io/${process.env.GITHUB_REPOSITORY_OWNER.toLowerCase()}/${app.repository}`,
    'App repository'
  );
  requireFact(c.smokeCommand === app.smokeCommand, 'App smoke command');
  requireFact(
    JSON.stringify(c.platforms) === JSON.stringify(indexPlatforms(c.image, c.digest)),
    'index manifest binding'
  );
  requireFact(
    typeof c.reused === 'boolean' && typeof c.latestBefore === 'string',
    'immutable retry state'
  );
  return c;
}
/** Require exactly one successful native observation for each manifest of the recorded index. */
export function verifyNativeEvidence(candidate, observations) {
  requireFact(Array.isArray(observations) && observations.length === 2, 'native evidence count');
  requireFact(
    candidate.platforms?.length === 2 &&
      candidate.platforms.map((p) => p.platform).join(',') === platforms.join(','),
    'native evidence platform set'
  );
  for (const entry of candidate.platforms) {
    const matches = observations.filter((o) => o.platform === entry.platform);
    requireFact(matches.length === 1, `native evidence missing or duplicate ${entry.platform}`);
    const o = matches[0];
    for (const key of ['repository', 'source', 'tag', 'runId', 'attempt', 'image'])
      requireFact(o[key] === candidate[key], `native evidence ${key}`);
    requireFact(
      o.indexDigest === candidate.digest &&
        o.digest === entry.digest &&
        o.conclusion === 'success' &&
        o.negativeFixture === 'address-space-assertion' &&
        o.inheritedAddressSpace === 'unlimited',
      `native evidence result or manifest ${entry.platform}`
    );
    verifyNativeHost(entry.platform, o.host);
  }
}
/** Execute the unchanged App smoke twice: the missing-AS fixture must fail, then the product must pass. */
function smoke(c, platform, output) {
  validateCandidate(c);
  requireFact(
    !process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT,
    'native host Docker context override'
  );
  const context = command('docker', ['context', 'show']);
  const host = {
    system: command('uname', ['-s']),
    kernel: command('uname', ['-m']),
    node: process.arch,
    runner: process.env.RUNNER_ARCH,
    docker: command('docker', ['info', '--format', '{{.OSType}}/{{.Architecture}}']),
    endpoint:
      process.env.DOCKER_HOST ||
      command('docker', ['context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}']),
  };
  verifyNativeHost(platform, host);
  const entry = c.platforms.find((p) => p.platform === platform);
  requireFact(entry, 'requested platform');
  const image = `${c.image}@${entry.digest}`;
  command('docker', ['pull', '--platform', platform, image]);
  const inheritedAddressSpace = command('docker', [
    'run',
    '--rm',
    '--platform',
    platform,
    image,
    '/bin/sh',
    '-c',
    'ulimit -v',
  ]);
  requireFact(
    inheritedAddressSpace === 'unlimited',
    'fixture inherited address-space limit masks a missing setter'
  );
  const directory = mkdtempSync(join(tmpdir(), 'openkit-app-native-'));
  try {
    const library = join(directory, 'no-as-limit.so');
    command('cc', [
      '-shared',
      '-fPIC',
      '-O2',
      fileURLToPath(new URL('./release-app-no-as-limit.c', import.meta.url)),
      '-ldl',
      '-o',
      library,
    ]);
    const negative = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '--platform',
        platform,
        '--mount',
        `type=bind,source=${library},target=/tmp/no-as-limit.so,readonly`,
        '--env',
        'LD_PRELOAD=/tmp/no-as-limit.so',
        image,
        '/bin/sh',
        '-ec',
        'test "$(ulimit -v)" = unlimited; exec "$@"',
        '--',
        c.smokeCommand,
      ],
      { encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024 }
    );
    const diagnostic = `${negative.stdout ?? ''}\n${negative.stderr ?? ''}`;
    requireFact(
      !negative.error &&
        !negative.signal &&
        negative.status !== 0 &&
        /ERR_ASSERTION/.test(diagnostic) &&
        /2147483648/.test(diagnostic) &&
        /Max address space\s+unlimited\s+unlimited/.test(diagnostic),
      'missing-AS fixture did not fail at the unchanged address-space assertion'
    );
    console.log(
      `Missing-AS fixture refused on ${platform}: unchanged address-space assertion, inherited unlimited.`
    );
    command('docker', ['run', '--rm', '--platform', platform, image, c.smokeCommand], {
      stdio: 'inherit',
      timeout: 300000,
    });
    writeFileSync(
      output,
      `${JSON.stringify(
        {
          ...identity(),
          image: c.image,
          indexDigest: c.digest,
          ...entry,
          host,
          inheritedAddressSpace,
          negativeFixture: 'address-space-assertion',
          conclusion: 'success',
        },
        null,
        2
      )}\n`
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
/** CLI commands exchange only current-attempt artifacts; promotion retains the existing identity checks. */
function main([mode, file, platform, output]) {
  if (mode === 'record') {
    const e = process.env;
    const c = {
      ...identity(),
      image: e.IMAGE,
      digest: e.DIGEST,
      smokeCommand: e.SMOKE_COMMAND,
      platforms: indexPlatforms(e.IMAGE, e.DIGEST),
      reused: e.REUSED === 'true',
      latestBefore: e.LATEST_BEFORE,
    };
    validateCandidate(c);
    writeFileSync(file, `${JSON.stringify(c, null, 2)}\n`);
  } else if (mode === 'smoke') {
    smoke(JSON.parse(readFileSync(file, 'utf8')), platform, output);
  } else if (mode === 'join') {
    const c = validateCandidate(JSON.parse(readFileSync(file, 'utf8')));
    verifyNativeEvidence(
      c,
      platforms.map((p) =>
        JSON.parse(readFileSync(join(platform, `${p.split('/')[1]}.json`), 'utf8'))
      )
    );
    requireFact(
      String(c.reused) === process.env.PRESENT &&
        (!c.reused || c.digest === process.env.EXISTING_DIGEST) &&
        c.latestBefore === process.env.LATEST_BEFORE,
      'immutable identity changed since candidate build'
    );
    console.log(`digest=${c.digest}\nreused=${c.reused}`);
  } else
    throw Error(
      'Usage: release-app-native.mjs record FILE | smoke FILE PLATFORM OUTPUT | join FILE EVIDENCE_DIRECTORY'
    );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
