#!/usr/bin/env node
/** Observe a published App on the development machine without replacing deployment, Worker or L6 evidence. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { verifyOperationsSkillArchive } from './package-release-assets.mjs';
import { command, commitAt, observePublication, requireRepository } from './release-observe.mjs';
import { canonical, noSecrets, sha } from './release-safety.mjs';

/** This command has no remote-host or default-target authority. */
export function localTarget(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Error('Explicit local development URL required');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw Error('Post-publication smoke is limited to an explicit loopback origin');
  return url.origin;
}

/** Bind the inspected running container to the explicit loopback HTTP port before using its identity. */
export function verifyLocalBinding(target, state) {
  const url = new URL(localTarget(target));
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const host = url.hostname === '[::1]' ? '::1' : url.hostname;
  const addresses = host === 'localhost' ? ['127.0.0.1', '::1'] : [host];
  const bindings = state.ports?.['8080/tcp'];
  const concrete = addresses.find((address) =>
    bindings?.some(
      (b) =>
        b.HostPort === port &&
        (b.HostIp === address || b.HostIp === (address.includes(':') ? '::' : '0.0.0.0'))
    )
  );
  if (state.running !== true || url.protocol !== 'http:' || !Array.isArray(bindings) || !concrete)
    throw Error('Target must be the running App container direct loopback HTTP binding');
  url.hostname = concrete.includes(':') ? `[${concrete}]` : concrete;
  return url.origin;
}

/** Resolve local configuration only, then pin all daemon reads to the proved Unix socket. */
export function localDocker(run, env = process.env) {
  const configured = env.DOCKER_CONTEXT
    ? run('docker', [
        'context',
        'inspect',
        env.DOCKER_CONTEXT,
        '--format',
        '{{.Endpoints.docker.Host}}',
      ])
    : env.DOCKER_HOST ||
      run('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
  if (!/^unix:\/\/\/[^\r\n]+$/.test(configured))
    throw Error('Post-publication smoke requires a local Unix Docker endpoint');
  const pinned = { ...env };
  delete pinned.DOCKER_CONTEXT;
  delete pinned.DOCKER_HOST;
  return (args) => run('docker', ['--host', configured, ...args], { env: pinned });
}

/** Transport output is private; malformed responses must not copy it into diagnostics. */
function decode(bytes) {
  try {
    return JSON.parse(bytes);
  } catch {
    throw Error('Invalid smoke observation JSON');
  }
}

/** Keep Docker image IDs, OCI index/platform digests and reported release identity in their own domains. */
export function verifyLocalIdentity({ published, local, build, repository, tag, source }) {
  const expected = published.platforms?.filter((p) => p.platform === local.platform);
  if (
    published.id !== 'app' ||
    published.prerelease !== true ||
    !/^ghcr\.io\/[a-z0-9._/-]+$/.test(published.image ?? '') ||
    !/^sha256:[a-f0-9]{64}$/.test(published.digest ?? '') ||
    !Array.isArray(expected) ||
    expected.length !== 1 ||
    !/^sha256:[a-f0-9]{64}$/.test(expected[0].digest ?? '') ||
    !/^sha256:[a-f0-9]{64}$/.test(local.imageId ?? '') ||
    !Array.isArray(local.repoDigests) ||
    ![published.digest, expected[0].digest].some((d) =>
      local.repoDigests.includes(`${published.image}@${d}`)
    ) ||
    local.labels?.['org.opencontainers.image.source'] !== `https://github.com/${repository}` ||
    local.labels['org.opencontainers.image.revision'] !== source ||
    local.labels['org.opencontainers.image.version'] !== tag.slice(1) ||
    build?.releaseTag !== tag ||
    build.sourceCommit !== source ||
    !published.tags?.includes(`${published.image}:${tag}`) ||
    !published.tags.includes(`${published.image}:sha-${source.slice(0, 12)}`)
  )
    throw Error('Published App and local deployment identities do not agree');
  return {
    imageId: local.imageId,
    indexDigest: published.digest,
    platform: local.platform,
    platformDigest: expected[0].digest,
  };
}

/** Invoke only the checksum-verified published administrator CLI through its existing credential custody. */
function cliCall(cli, target, operation, input, run) {
  const env = { ...process.env, OPENKIT_NANOCORE_URL: target };
  const description = decode(
    run(process.execPath, [cli, 'ops', 'describe', operation], { env, timeout: 30000 })
  );
  if (description.ok !== true || description.data?.mutating !== false)
    throw Error('Smoke accepts described read-only public operations only');
  const result = decode(
    run(process.execPath, [cli, 'ops', 'call', operation, '--input', '-'], {
      input: JSON.stringify(input),
      env,
      timeout: 30000,
    })
  );
  if (result.ok !== true || result.operation !== operation)
    throw Error('Public smoke read did not succeed');
  return result.data;
}

/** Verify publication and App identity, then compare bounded retained public reads with their prior observations. */
export function postPublicationSmoke(
  { target, params, output },
  {
    run = command,
    publication = observePublication,
    verifySkill = verifyOperationsSkillArchive,
    now = () => new Date().toISOString(),
  } = {}
) {
  target = localTarget(target);
  noSecrets(params);
  requireRepository(params.repository);
  if (
    !/^v\d+\.\d+\.\d+-[a-z0-9][a-z0-9.-]*$/.test(params.tag ?? '') ||
    !/^[a-f0-9]{40}$/.test(params.sha ?? '') ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(params.container ?? '') ||
    !Array.isArray(params.reads) ||
    params.reads.length < 1 ||
    params.reads.length > 8
  )
    throw Error(
      'Exact published prerelease, local container and one to eight retained reads required'
    );
  if (commitAt('HEAD') !== params.sha)
    throw Error('Use the reviewed published checkout for smoke verification');
  if (Number(process.versions.node.split('.')[0]) !== 24)
    throw Error('Published CLI verification requires Node.js 24');
  mkdirSync(output, { mode: 0o700 });
  const result = {
    tag: params.tag,
    sha: params.sha,
    start: now(),
    outcome: 'failed',
    scope: 'local-app-identity-and-retained-public-reads',
    reads: [],
  };
  try {
    const docker = localDocker(run);
    publication({
      repository: params.repository,
      tag: params.tag,
      sha: params.sha,
      runId: params.runId,
    });
    const reference = `refs/tags/${params.tag}`;
    const refs = run('git', [
      'ls-remote',
      `https://github.com/${params.repository}.git`,
      reference,
      `${reference}^{}`,
    ])
      .split('\n')
      .map((line) => line.split(/\s+/));
    const tagged =
      refs.find((r) => r[1] === `${reference}^{}`) ?? refs.find((r) => r[1] === reference);
    if (tagged?.[0] !== params.sha)
      throw Error('Public tag source differs from the verified publication');
    const assets = join(output, 'published');
    const skill = `openkit-ops-skill-${params.tag}.tar.gz`;
    run('gh', [
      'release',
      'download',
      params.tag,
      '--repo',
      params.repository,
      '--pattern',
      skill,
      '--pattern',
      'SHA256SUMS',
      '--dir',
      assets,
    ]);
    const checksums = readFileSync(join(assets, 'SHA256SUMS'), 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line.endsWith(`  ${skill}`));
    if (
      checksums.length !== 1 ||
      checksums[0] !== `${sha(readFileSync(join(assets, skill)))}  ${skill}`
    )
      throw Error('Published Skill checksum mismatch');
    const { cliPath } = verifySkill({
      archivePath: join(assets, skill),
      destDir: join(output, 'operations'),
    });
    run('gh', [
      'run',
      'download',
      String(params.runId),
      '--repo',
      params.repository,
      '--name',
      'release-image-app',
      '--dir',
      assets,
    ]);
    const published = decode(readFileSync(join(assets, 'app.json'), 'utf8'));
    target = verifyLocalBinding(target, {
      running:
        docker([
          'inspect',
          '--type',
          'container',
          '--format',
          '{{.State.Running}}',
          params.container,
        ]) === 'true',
      ports: decode(
        docker([
          'inspect',
          '--type',
          'container',
          '--format',
          '{{json .NetworkSettings.Ports}}',
          params.container,
        ])
      ),
    });
    const imageId = docker([
      'inspect',
      '--type',
      'container',
      '--format',
      '{{.Image}}',
      params.container,
    ]);
    const local = {
      imageId,
      platform: docker(['image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', imageId]),
      labels: decode(docker(['image', 'inspect', '--format', '{{json .Config.Labels}}', imageId])),
      repoDigests: decode(
        docker(['image', 'inspect', '--format', '{{json .RepoDigests}}', imageId])
      ),
    };
    const diagnostics = cliCall(cliPath, target, 'diagnostics.app', {}, run);
    result.identities = verifyLocalIdentity({
      published,
      local,
      build: diagnostics.build,
      repository: params.repository,
      tag: params.tag,
      source: params.sha,
    });
    for (const [index, read] of params.reads.entries()) {
      if (
        !/^[a-f0-9]{64}$/.test(read.sha256 ?? '') ||
        typeof read.operation !== 'string' ||
        !read.input ||
        typeof read.input !== 'object'
      )
        throw Error('Retained read requires an operation, input and prior result digest');
      const observed = cliCall(cliPath, target, read.operation, read.input, run);
      const digest = sha(canonical(observed));
      if (digest !== read.sha256) throw Error(`Retained public read ${index + 1} differs`);
      result.reads.push({ ordinal: index + 1, operation: read.operation, sha256: digest });
    }
    result.outcome = 'passed';
    return result;
  } finally {
    result.end = now();
    writeFileSync(
      join(output, 'post-publication-smoke.json'),
      `${JSON.stringify(result, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 }
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({
      options: {
        target: { type: 'string' },
        params: { type: 'string' },
        output: { type: 'string' },
      },
    });
    if (!values.target || !values.params || !values.output)
      throw Error('Explicit local target, private params and new output directory required');
    const result = postPublicationSmoke({
      target: values.target,
      params: JSON.parse(readFileSync(values.params, 'utf8')),
      output: values.output,
    });
    console.log(
      JSON.stringify({
        tag: result.tag,
        sha: result.sha,
        outcome: result.outcome,
        reads: result.reads.length,
      })
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
