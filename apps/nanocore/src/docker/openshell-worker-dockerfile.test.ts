import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const sharedDockerfilePath = join(repoRoot, 'containers', 'workers', 'Dockerfile');
const launcherPath = join(repoRoot, 'containers', 'workers', 'openkit-worker-shim');
const commonSmokePath = join(repoRoot, 'containers', 'workers', 'smoke-common.sh');
const imageManifestPath = join(repoRoot, 'containers', 'images.json');
const buildImageScriptPath = join(repoRoot, 'scripts', 'docker', 'build-image.sh');
const releaseWorkflowPath = join(repoRoot, '.github', 'workflows', 'ci.yml');
const codexSchemaMetadataPath = join(
  repoRoot,
  'packages',
  'codex-app-server-schema',
  'metadata.json'
);
const workerImageSpecPath = join(
  repoRoot,
  'docs',
  'specs',
  '20260721-worker_execution_environment_images.md'
);

/** Current OpenKit worker leaves and their singular catalog-declared runtimes. */
const workerImageContracts = [
  {
    id: 'worker-codex',
    manifest: 'codex.agent.jsonc',
    nativeBinary: '/usr/local/bin/codex',
    nativeVersion: '0.153.4',
    runtime: 'codex',
  },
  {
    id: 'worker-opencode',
    manifest: 'opencode-server.agent.jsonc',
    nativeBinary: '/usr/local/bin/opencode',
    nativeVersion: '1.18.1',
    runtime: 'opencode',
  },
  {
    id: 'worker-pi',
    manifest: 'pi.agent.jsonc',
    nativeBinary: '/usr/local/bin/pi',
    nativeVersion: '0.85.1',
    runtime: 'pi',
  },
] as const;

const commonToolPaths = [
  '/usr/bin/git',
  '/usr/local/bin/gh',
  '/usr/local/bin/node',
  '/usr/local/bin/npm',
  '/usr/local/bin/npx',
  '/usr/local/bin/pnpm',
  '/usr/local/bin/pnpx',
  '/usr/local/bin/uv',
  '/sandbox/.venv/bin/python',
  '/sandbox/.venv/bin/python3',
  '/sandbox/.venv/bin/pip',
  '/sandbox/.venv/bin/pip3',
] as const;

const canonicalWorkspaceRoots = [
  '/workspace/worktrees/main',
  '/workspace/inputs',
  '/workspace/data',
  '/workspace/artifacts/in',
  '/workspace/outputs',
  '/workspace/scratch',
  '/workspace/.openkit/cache',
  '/openkit/session',
  '/openkit/sessions',
  '/openkit/instructions',
] as const;

describe('governed worker image contracts', () => {
  it('builds current worker images from one shared Dockerfile with unique targets', () => {
    const workers = readWorkerCatalog();
    const base = workers.find((worker) => worker.id === 'worker-common');

    expect(base).toEqual(
      expect.objectContaining({
        dockerfile: 'containers/workers/Dockerfile',
        target: 'worker-common',
      })
    );
    expect(base).not.toHaveProperty('runtime');
    expect(base).not.toHaveProperty('workerContract');
    for (const leaf of workerImageContracts) {
      const worker = workers.find((entry) => entry.id === leaf.id);

      expect(worker).toMatchObject({
        dockerfile: 'containers/workers/Dockerfile',
        runtime: leaf.runtime,
        target: leaf.id,
      });
    }
    expect(new Set(workers.map((worker) => worker.target)).size).toBe(workers.length);
    expect(new Set(workers.map((worker) => worker.baseImage)).size).toBe(1);
    expect(base?.baseImage ?? workers[0]?.baseImage).toBe(
      'node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d'
    );
  });

  it('defines the complete pinned common development environment without baked policy', () => {
    const dockerfile = readFileSync(sharedDockerfilePath, 'utf8');

    expect(dockerfile).toContain(
      'FROM ghcr.io/astral-sh/uv:0.11.30@sha256:93b61e21202b1dab861092748e46bbd6e0e41dd84f59b9174efd2353186e1b47 AS uv'
    );
    expect(dockerfile).toContain('ARG PYTHON_VERSION="3.14.6"');
    expect(dockerfile).toContain('ARG GH_VERSION="2.96.0"');
    expect(dockerfile).toContain('corepack prepare pnpm@10.33.3 --activate');
    for (const systemPackage of [
      'build-essential',
      'curl',
      'dnsutils',
      'fd-find',
      'file',
      'git',
      'iproute2',
      'iputils-ping',
      'jq',
      'lsof',
      'nano',
      'net-tools',
      'netcat-openbsd',
      'openssh-client',
      'passwd',
      'pkg-config',
      'procps',
      'ripgrep',
      'tar',
      'traceroute',
      'unzip',
      'vim',
      'xz-utils',
    ]) {
      expect(dockerfile).toContain(systemPackage);
    }
    expect(dockerfile).toContain(`uv python install "\${PYTHON_VERSION}"`);
    expect(dockerfile).toContain(`uv venv --python "\${PYTHON_VERSION}" --seed /sandbox/.venv`);
    expect(dockerfile).toContain('ln -s /usr/bin/fdfind /usr/local/bin/fd');
    expect(dockerfile).not.toContain('/etc/openshell/policy.yaml');
    expect(dockerfile).not.toMatch(/COPY\s+.*policy\.ya?ml/);
  });

  it('builds the generic shim once and prepares the non-root writable runtime layout', () => {
    const dockerfile = readFileSync(sharedDockerfilePath, 'utf8');
    const smoke = readFileSync(commonSmokePath, 'utf8');
    const commonRuntimeSetup = dockerfile.slice(
      dockerfile.indexOf('&& mkdir -p'),
      dockerfile.indexOf('ENTRYPOINT ["tini"')
    );
    const workerCommonBuild = dockerCommonSection(dockerfile);
    const workerCommonBuildWrites = workerCommonBuild.replace(/^CMD .*$/gm, '');

    expect(dockerfile).toContain('COPY packages/worker-protocol/package.json');
    expect(dockerfile).toContain('pnpm --filter @openkit/worker-protocol build');
    expect(dockerfile).toContain('pnpm --filter @openkit/worker-shim build');
    expect(dockerfile).toContain('pnpm --filter @openkit/worker-shim deploy --prod --legacy');
    expect(dockerfile).toContain('/usr/local/lib/openkit/worker-shim');
    expect(dockerfile).toContain('COPY containers/workers/openkit-worker-shim');
    expect(dockerfile).toContain(
      'COPY containers/workers/openkit-file-effect /usr/local/bin/openkit-file-effect'
    );
    expect(dockerfile).toContain('/usr/sbin/groupadd --system sandbox');
    expect(dockerfile).toContain('/usr/sbin/useradd --system --gid sandbox --home-dir /sandbox');
    expect(dockerfile).toContain('/sandbox/openkit/session');
    expect(commonRuntimeSetup).toContain('/sandbox/openkit/sessions');
    expect(dockerfile).toContain('ln -s /sandbox/openkit /openkit');
    expect(dockerfile).toContain('chown -R sandbox:sandbox /sandbox /workspace');
    expect(workerCommonBuildWrites).not.toContain('/openkit/config/package.json');
    expect(workerCommonBuild).not.toMatch(/^(?:COPY|ADD)\s+.*\s+\/openkit\/config(?:\/|\s|$)/m);
    expect(dockerCommonSection(dockerfile)).toContain('USER sandbox');
    for (const { id } of workerImageContracts) {
      expect(dockerTargetSection(dockerfile, id)).toContain('USER sandbox');
    }
    expect(smoke).toContain('test -x /usr/local/bin/openkit-file-effect');
    for (const root of canonicalWorkspaceRoots) {
      expect(commonRuntimeSetup).toContain(root);
      expect(smoke).toContain(root);
    }
  });

  it.each(
    workerImageContracts
  )('keeps $runtime target contents aligned with its catalog-declared runtime set', ({
    id,
    manifest,
    nativeBinary,
    nativeVersion,
    runtime,
  }) => {
    const workers = readWorkerCatalog();
    const image = workers.find((entry) => entry.id === id);
    const dockerfile = readFileSync(sharedDockerfilePath, 'utf8');
    const targetSection = dockerTargetSection(dockerfile, id);
    const agentManifest = readAgentManifest(manifest);
    const declaredRuntimes = catalogDeclaredRuntimeSet(image);

    expect(image).toMatchObject({ runtime, target: id });
    expect(declaredRuntimes).toEqual([runtime]);
    expect(targetSection).toContain(`LABEL org.openkit.worker.runtime="${runtime}"`);
    expect(targetSection).toContain(`COPY containers/${id}/smoke.sh`);
    expect(targetSection).toContain('USER sandbox');
    expect(agentManifest.runtime).toMatchObject({
      adapter: runtime,
      image: { kind: 'reference', ref: image?.localTag },
      version: nativeVersion,
    });
    expect(agentManifest.runtime.binaries.map((binary) => binary.path)).toContain(nativeBinary);
    for (const undeclaredRuntime of firstPartyRuntimes(workers).filter(
      (candidate) => !declaredRuntimes.includes(candidate)
    )) {
      expect(targetSection).not.toContain(`org.openkit.worker.runtime="${undeclaredRuntime}"`);
      expect(targetSection).not.toContain(`containers/worker-${undeclaredRuntime}/smoke.sh`);
    }
  });

  it('keeps OpenCode ambient config absent and Pi credential passthrough immutable', () => {
    const dockerfile = readFileSync(sharedDockerfilePath, 'utf8');
    const launcher = readFileSync(launcherPath, 'utf8');
    const openCodeSection = dockerTargetSection(dockerfile, 'worker-opencode');
    const piSection = dockerTargetSection(dockerfile, 'worker-pi');

    expect(openCodeSection).toContain('test ! -e /etc/opencode');
    expect(openCodeSection).toContain('export HOME=/tmp/opencode-home');
    expect(piSection).toContain('/usr/local/lib/openkit/allow-anthropic-api-key');
    expect(launcher).toContain('if [[ -f /usr/local/lib/openkit/allow-anthropic-api-key ]]');
    expect(launcher).toContain(`ANTHROPIC_API_KEY=\${ANTHROPIC_API_KEY:-}`);
    expect(dockerTargetSection(dockerfile, 'worker-codex')).not.toContain(
      'allow-anthropic-api-key'
    );
    expect(openCodeSection).not.toContain('allow-anthropic-api-key');
  });

  it('keeps the Pi image smoke dry-run on the adapter-accepted direct-provider route', () => {
    const smoke = readFileSync(join(repoRoot, 'containers', 'worker-pi', 'smoke.sh'), 'utf8');
    const encodedPackage = /printf '%s\\n' '(\{.*\})'/.exec(smoke)?.[1];

    expect(encodedPackage).toEqual(expect.stringMatching(/^\{/));
    const route = (
      JSON.parse(encodedPackage ?? '{}') as {
        llm?: { routes?: Array<Record<string, unknown>> };
      }
    ).llm?.routes?.[0];

    expect(route).toEqual(
      expect.objectContaining({
        credentialVisibility: 'environment',
        endpoint: {
          kind: 'provider-compatible',
          upstream: { kind: 'direct-provider' },
        },
        model: 'claude-sonnet-4-5',
        providerInstanceId: 'anthropic',
      })
    );
    expect(encodedPackage).not.toContain('"credentialVisibility":"placeholder"');
    expect(encodedPackage).not.toContain('"kind":"openai-compatible"');
    expect(encodedPackage).not.toContain('"kind":"nanocore-gateway"');
  });

  it('keeps root-owned build state out of the writable worker home', () => {
    const dockerfile = readFileSync(sharedDockerfilePath, 'utf8');
    const smoke = readFileSync(commonSmokePath, 'utf8');

    for (const { id } of workerImageContracts) {
      const targetSection = dockerTargetSection(dockerfile, id);

      expect(targetSection).toContain('NPM_CONFIG_CACHE=/tmp/npm-cache');
      expect(targetSection).toContain('rm -rf');
    }
    expect(dockerTargetSection(dockerfile, 'worker-codex')).toContain('CODEX_HOME=/tmp/codex-home');
    expect(smoke).toContain('find /sandbox /workspace -xdev -uid 0 -print -quit');
  });

  it('authors the same exact development grants in every built-in AgentManifest', () => {
    for (const contract of workerImageContracts) {
      const manifest = readAgentManifest(contract.manifest);
      const binaryPaths = manifest.runtime.binaries.map((binary) => binary.path);

      expect(binaryPaths).toEqual(expect.arrayContaining([...commonToolPaths]));
      expect(manifest.sandbox.network).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            binaries: ['/usr/bin/git'],
            host: 'github.com',
            id: 'github-git-read',
            rules: [
              { method: 'GET', path: '/**/info/refs*' },
              { method: 'POST', path: '/**/git-upload-pack' },
            ],
          }),
          expect.objectContaining({
            access: 'read-only',
            binaries: ['/usr/local/bin/gh'],
            host: 'api.github.com',
            id: 'github-rest-read',
          }),
          expect.objectContaining({
            access: 'read-only',
            host: 'registry.npmjs.org',
            id: 'npm-registry-read',
          }),
          expect.objectContaining({
            access: 'read-only',
            host: 'pypi.org',
            id: 'pypi-index-read',
          }),
          expect.objectContaining({
            access: 'read-only',
            host: 'files.pythonhosted.org',
            id: 'pypi-files-read',
          }),
        ])
      );
      expect(JSON.stringify(manifest.sandbox.network)).not.toContain('git-receive-pack');
    }
  });

  it('uses one sanitized zero-argument Harness launcher', () => {
    const launcher = readFileSync(launcherPath, 'utf8');
    const environmentLauncher = launcher.replace(
      /exec env -i "\$\{runtime_env\[@\]\}" node .*$/gm,
      `exec env -i "\${runtime_env[@]}" /usr/bin/env`
    );
    const inherited = {
      ALL_PROXY: 'http://proxy.invalid:8080',
      HOME: '/sandbox',
      NO_PROXY: '127.0.0.1,localhost',
      PATH: '/sandbox/.venv/bin:/usr/local/bin:/usr/bin:/bin',
      no_proxy: 'localhost,127.0.0.1',
    };
    const output = execFileSync('/bin/bash', ['-c', environmentLauncher], {
      encoding: 'utf8',
      env: {
        ...inherited,
        OPENKIT_AGENT_SESSION_ID: 'must-not-cross-static-bootstrap',
        OPENKIT_WORKER_CAPABILITY_TOKEN: 'must-not-cross-static-bootstrap',
        OPENKIT_WORKER_INFERENCE_TOKEN: 'must-not-cross-static-bootstrap',
      },
    });
    const environment = Object.fromEntries(
      output
        .trim()
        .split('\n')
        .map((line) => {
          const separator = line.indexOf('=');
          return [line.slice(0, separator), line.slice(separator + 1)];
        })
    );

    expect(environment.ALL_PROXY).toBe(inherited.ALL_PROXY);
    expect(environment.NO_PROXY).toBe(inherited.NO_PROXY);
    expect(environment.no_proxy).toBe(inherited.no_proxy);
    expect(environment.VIRTUAL_ENV).toBe('/sandbox/.venv');
    expect(environment).not.toHaveProperty('OPENKIT_AGENT_SESSION_ID');
    expect(environment).not.toHaveProperty('OPENKIT_CONTROL_TOKEN');
    expect(environment).not.toHaveProperty('OPENKIT_CONTROL_TOKEN_FD');
    expect(environment).not.toHaveProperty('OPENKIT_WORKER_CAPABILITY_TOKEN');
    expect(environment).not.toHaveProperty('OPENKIT_WORKER_INFERENCE_TOKEN');
    expect(environment).not.toHaveProperty('ANTHROPIC_API_KEY');

    const childLaunchMarker = 'OPENKIT_CHILD_LAUNCHED';
    const rejectionLauncher = launcher.replace(
      /exec env -i "\$\{runtime_env\[@\]\}" node .*$/gm,
      `/usr/bin/printf '%s\\n' '${childLaunchMarker}'`
    );
    const rejected = spawnSync('/bin/bash', ['-c', rejectionLauncher, 'openkit-worker-shim', 'x'], {
      encoding: 'utf8',
      env: inherited,
    });

    expect(rejected.error).toBeUndefined();
    expect(rejected.status).toBe(64);
    expect(rejected.stdout).toBe('');
    expect(rejected.stderr).toBe('Worker Harness accepts no arguments.\n');
    expect(`${rejected.stdout}${rejected.stderr}`).not.toContain(childLaunchMarker);
    expect(launcher).toContain('NODE_USE_ENV_PROXY=1');
    expect(launcher).not.toContain(`\${OPENKIT_CONTROL_TOKEN:-}`);
    expect(launcher).not.toContain(`\${OPENKIT_WORKER_INFERENCE_TOKEN:-}`);
    expect(launcher).not.toContain(`\${OPENKIT_WORKER_CAPABILITY_TOKEN:-}`);
  });

  it('smokes the complete common tool, version, writable-path, and policy boundary', () => {
    const smoke = readFileSync(commonSmokePath, 'utf8');

    for (const command of [
      'node',
      'npm',
      'pnpm',
      'python',
      'pip',
      'uv',
      'gh',
      'git',
      'vim',
      'nano',
      'ping',
      'dig',
      'nslookup',
      'nc',
      'traceroute',
      'netstat',
      'curl',
      'rg',
      'fd',
      'jq',
      'mise',
    ]) {
      expect(smoke).toContain(`command -v ${command}`);
    }
    expect(smoke).toContain('24.18.0');
    expect(smoke).toContain('Python 3.14.6');
    expect(smoke).toContain('0[.]11[.]30');
    expect(smoke).toContain('gh version 2.96.0');
    expect(smoke).toContain('10.33.3');
    expect(smoke).toContain('2026.8.14');
    expect(smoke).toContain('test "$(stat -c \'%u\' /usr/local/bin/mise)" -eq 0');
    expect(smoke).toContain('test ! -w /usr/local/bin/mise');
    expect(smoke).toContain('test ! -e /etc/openshell/policy.yaml');
    expect(smoke).toContain('find /sandbox /workspace -xdev -uid 0 -print -quit');
    expect(smoke).toContain('/sandbox/.venv');
  });

  it('pins mise 2026.8.14 into the common stage with architecture-specific SHA256 and ends as sandbox', () => {
    const dockerfile = readFileSync(sharedDockerfilePath, 'utf8');
    const common = dockerCommonSection(dockerfile);
    const specMiseVersion = /^\|\s*mise\s*\|\s*`([^`]+)`/im.exec(
      readFileSync(workerImageSpecPath, 'utf8')
    )?.[1];
    const dockerfileMiseVersion = /^ARG MISE_VERSION="([^"]+)"$/m.exec(common)?.[1];

    expect(specMiseVersion).toEqual(expect.stringMatching(/^\d+\.\d+\.\d+$/));
    expect(dockerfileMiseVersion).toBe(specMiseVersion);
    expect(common).toMatch(/ARG MISE_AMD64_SHA256="[a-f0-9]{64}"/);
    expect(common).toMatch(/ARG MISE_ARM64_SHA256="[a-f0-9]{64}"/);
    expect(common).toContain('/usr/local/bin/mise');
    expect(common).toContain('LABEL org.openkit.image="worker-common"');
    expect(common).toMatch(/LABEL org.openkit.smoke="/);
    expect(common).toContain('USER sandbox');
    expect(common).not.toContain('USER root');
  });

  it('regains root only in deployment stages to install the native runtime, then returns to sandbox', () => {
    const dockerfile = readFileSync(sharedDockerfilePath, 'utf8');

    for (const { id } of workerImageContracts) {
      const targetSection = dockerTargetSection(dockerfile, id);

      expect(targetSection).toMatch(/USER root[\s\S]*USER sandbox/);
      expect(targetSection.match(/USER root/g)).toHaveLength(1);
      expect(targetSection.match(/USER sandbox/g)).toHaveLength(1);
    }
  });

  it('smokes the published empty declared runtime set by reusing common checks and proving no first-party Agent CLI', () => {
    const workers = readWorkerCatalog();
    const base = workers.find((entry) => entry.id === 'worker-common');
    const smokePath = join(repoRoot, base?.smoke ?? 'missing-worker-common-smoke');

    expect(base).toEqual(
      expect.objectContaining({
        id: 'worker-common',
        smoke: 'containers/workers/openkit-worker-common-base-smoke.sh',
        target: 'worker-common',
      })
    );
    expect(catalogDeclaredRuntimeSet(base)).toEqual([]);
    expect(existsSync(smokePath)).toBe(true);

    const smoke = readFileSync(smokePath, 'utf8');

    expect(smoke).toContain('openkit-worker-common-smoke');
    for (const runtime of firstPartyRuntimes(workers)) {
      expect(smoke).toContain(`! command -v ${runtime}`);
    }
  });

  it('passes the manifest target through local Docker builds', () => {
    const buildScript = readFileSync(buildImageScriptPath, 'utf8');

    expect(buildScript).toContain('read_optional_image_field target');
    expect(buildScript).toContain(`docker_args+=(--target "\${target}")`);
    expect(buildScript).toContain(`docker build "\${docker_args[@]}" "\${context}"`);
  });

  it('passes the manifest target through worker smoke and release candidate builds', () => {
    const workflow = readFileSync(releaseWorkflowPath, 'utf8');

    expect(workflow).toContain("target: image.target || ''");
    expect(workflow.match(/target: \$\{\{ matrix\.target \}\}/g)).toHaveLength(2);
  });

  it('keeps the worker Codex version aligned with the vendored app-server schema', () => {
    const dockerfile = readFileSync(sharedDockerfilePath, 'utf8');
    const metadata = JSON.parse(readFileSync(codexSchemaMetadataPath, 'utf8')) as {
      sourcePackage: string;
    };
    const imageVersion = /^ARG CODEX_CLI_VERSION="([^"]+)"$/m.exec(dockerfile)?.[1];
    const schemaVersion = /^@openai\/codex@(.+)$/.exec(metadata.sourcePackage)?.[1];

    expect(imageVersion).toBe(schemaVersion);
  });
});

/** One image catalog entry used by the worker build contract. */
interface WorkerImageEntry {
  readonly baseImage: string;
  readonly dockerfile: string;
  readonly id: string;
  readonly kind: string;
  readonly localTag: string;
  readonly runtime?: string;
  readonly smoke: string;
  readonly target: string;
  readonly workerContract?: string;
}

/**
 * Returns the catalog-declared runtime set for one worker image.
 *
 * Singular `runtime` metadata is the current declared set. Omission is the empty set.
 *
 * @param entry Worker catalog entry, when present.
 * @returns Declared runtime names.
 */
function catalogDeclaredRuntimeSet(entry: WorkerImageEntry | undefined): string[] {
  return entry?.runtime ? [entry.runtime] : [];
}

/**
 * Collects first-party runtimes currently declared on worker catalog entries.
 *
 * @param workers Worker catalog entries.
 * @returns Unique catalog-declared runtime names.
 */
function firstPartyRuntimes(workers: readonly WorkerImageEntry[]): string[] {
  return [...new Set(workers.flatMap((worker) => catalogDeclaredRuntimeSet(worker)))];
}

/** One parsed built-in AgentManifest slice required by these tests. */
interface WorkerAgentManifest {
  readonly runtime: {
    readonly adapter: string;
    readonly binaries: Array<{ readonly path: string }>;
    readonly image: { readonly kind: 'reference' | 'build'; readonly ref?: string };
    readonly version?: string;
  };
  readonly sandbox: {
    readonly network: Array<Record<string, unknown>>;
  };
}

/**
 * Reads worker entries from the repository image catalog.
 *
 * @returns Worker image entries in catalog order.
 */
function readWorkerCatalog(): WorkerImageEntry[] {
  const catalog = JSON.parse(readFileSync(imageManifestPath, 'utf8')) as {
    images: WorkerImageEntry[];
  };

  return catalog.images.filter((entry) => entry.kind === 'worker');
}

/**
 * Reads one repository-owned AgentManifest template.
 *
 * @param filename Manifest filename beneath the NanoCore data templates.
 * @returns Parsed manifest slice.
 */
function readAgentManifest(filename: string): WorkerAgentManifest {
  return JSON.parse(
    readFileSync(
      join(repoRoot, 'apps', 'nanocore', 'data-templates', 'config', 'agents', filename),
      'utf8'
    )
  ) as WorkerAgentManifest;
}

/**
 * Extracts one final target body from the shared multi-target Dockerfile.
 *
 * @param dockerfile Complete Dockerfile text.
 * @param target Final target name.
 * @returns Target body through the next stage declaration or end of file.
 */
function dockerTargetSection(dockerfile: string, target: string): string {
  const marker = `FROM worker-common AS ${target}`;
  const start = dockerfile.indexOf(marker);

  expect(start).toBeGreaterThanOrEqual(0);
  const next = dockerfile.indexOf('\nFROM ', start + marker.length);
  return dockerfile.slice(start, next === -1 ? undefined : next);
}

/**
 * Extracts the published common stage from the shared multi-target Dockerfile.
 *
 * @param dockerfile Complete Dockerfile text.
 * @returns Common stage body through the first deployment target declaration.
 */
function dockerCommonSection(dockerfile: string): string {
  const marker = ' AS worker-common';
  const start = dockerfile.indexOf(marker);

  expect(start).toBeGreaterThanOrEqual(0);
  const next = dockerfile.indexOf('\nFROM worker-common AS ', start + marker.length);
  return dockerfile.slice(start, next === -1 ? undefined : next);
}
