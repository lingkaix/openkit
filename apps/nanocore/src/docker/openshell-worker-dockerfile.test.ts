import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

const workerImageContracts = [
  {
    id: 'worker-codex',
    manifest: 'codex.agent.jsonc',
    nativeBinary: '/usr/local/bin/codex',
    nativeVersion: '0.144.1',
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
    nativeVersion: '0.80.7',
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
  '/openkit/context',
  '/openkit/instructions',
] as const;

describe('governed worker image contracts', () => {
  it('builds three release images from one shared Dockerfile and unique final targets', () => {
    const workers = readWorkerCatalog();

    expect(workers.map((worker) => worker.dockerfile)).toEqual([
      'containers/workers/Dockerfile',
      'containers/workers/Dockerfile',
      'containers/workers/Dockerfile',
    ]);
    expect(workers.map((worker) => worker.target)).toEqual([
      'worker-codex',
      'worker-opencode',
      'worker-pi',
    ]);
    expect(new Set(workers.map((worker) => worker.target)).size).toBe(3);
    expect(new Set(workers.map((worker) => worker.baseImage)).size).toBe(1);
    expect(workers[0]?.baseImage).toBe(
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
    const workerCommonBuild = dockerfile.slice(
      dockerfile.indexOf(' AS worker-common'),
      dockerfile.indexOf('FROM worker-common AS worker-codex')
    );
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
    expect(commonRuntimeSetup).toContain('/sandbox/openkit/config');
    expect(dockerfile).toContain('ln -s /sandbox/openkit /openkit');
    expect(dockerfile).toContain('chown -R sandbox:sandbox /sandbox /workspace');
    expect(workerCommonBuildWrites).not.toContain('/openkit/config/package.json');
    expect(workerCommonBuild).not.toMatch(/^(?:COPY|ADD)\s+.*\s+\/openkit\/config(?:\/|\s|$)/m);
    expect(dockerfile.match(/USER sandbox/g)).toHaveLength(3);
    expect(smoke).toContain('test -x /usr/local/bin/openkit-file-effect');
    for (const root of canonicalWorkspaceRoots) {
      expect(commonRuntimeSetup).toContain(root);
      expect(smoke).toContain(root);
    }
  });

  it.each(
    workerImageContracts
  )('keeps $runtime target, manifest, version, and exact-one-runtime authority aligned', ({
    id,
    manifest,
    nativeBinary,
    nativeVersion,
    runtime,
  }) => {
    const image = readWorkerCatalog().find((entry) => entry.id === id);
    const dockerfile = readFileSync(sharedDockerfilePath, 'utf8');
    const targetSection = dockerTargetSection(dockerfile, id);
    const agentManifest = readAgentManifest(manifest);

    expect(image).toMatchObject({ runtime, target: id });
    expect(targetSection).toContain(`LABEL org.openkit.worker.runtime="${runtime}"`);
    expect(targetSection).toContain(`COPY containers/${id}/smoke.sh`);
    expect(targetSection).toContain('USER sandbox');
    expect(agentManifest.runtime).toMatchObject({
      adapter: runtime,
      image: { kind: 'reference', ref: image?.localTag },
      version: nativeVersion,
    });
    expect(agentManifest.runtime.binaries.map((binary) => binary.path)).toContain(nativeBinary);
    for (const otherRuntime of ['codex', 'opencode', 'pi'].filter(
      (candidate) => candidate !== runtime
    )) {
      expect(targetSection).not.toContain(`org.openkit.worker.runtime="${otherRuntime}"`);
      expect(targetSection).not.toContain(`containers/worker-${otherRuntime}/smoke.sh`);
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

  it('keeps root-owned build state out of the writable worker home', () => {
    const dockerfile = readFileSync(sharedDockerfilePath, 'utf8');
    const smoke = readFileSync(commonSmokePath, 'utf8');

    for (const id of ['worker-codex', 'worker-opencode', 'worker-pi']) {
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
    expect(readAgentManifest('pi.agent.jsonc').sandbox.network).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          binaries: ['/usr/local/bin/node'],
          host: 'api.anthropic.com',
          id: 'anthropic-api',
        }),
      ])
    );
  });

  it('uses one sanitized launcher for static Harness and bounded-turn modes', () => {
    const launcher = readFileSync(launcherPath, 'utf8');
    const workerControlToken = 'A'.repeat(43);
    const workerInferenceToken = 'B'.repeat(43);
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
    const output = execFileSync(
      '/bin/bash',
      [
        '-c',
        environmentLauncher,
        'openkit-worker-shim',
        '--package',
        '/openkit/config/package.json',
      ],
      {
        encoding: 'utf8',
        env: inherited,
        input: `${workerControlToken}\n${workerInferenceToken}\n`,
      }
    );
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
    expect(environment).not.toHaveProperty('OPENKIT_CONTROL_TOKEN');
    expect(environment).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(environment.OPENKIT_WORKER_INFERENCE_TOKEN).toBe(workerInferenceToken);

    const harnessOutput = execFileSync('/bin/bash', ['-c', environmentLauncher], {
      encoding: 'utf8',
      env: {
        ...inherited,
        OPENKIT_AGENT_SESSION_ID: 'must-not-cross-static-bootstrap',
        OPENKIT_WORKER_INFERENCE_TOKEN: workerInferenceToken,
      },
    });
    const harnessEnvironment = Object.fromEntries(
      harnessOutput
        .trim()
        .split('\n')
        .map((line) => {
          const separator = line.indexOf('=');
          return [line.slice(0, separator), line.slice(separator + 1)];
        })
    );
    expect(harnessEnvironment).not.toHaveProperty('OPENKIT_AGENT_SESSION_ID');
    expect(harnessEnvironment).not.toHaveProperty('OPENKIT_CONTROL_TOKEN_FD');
    expect(harnessEnvironment).not.toHaveProperty('OPENKIT_WORKER_INFERENCE_TOKEN');

    const childLaunchMarker = 'OPENKIT_CHILD_LAUNCHED';
    const rejectionLauncher = launcher.replace(
      /exec env -i "\$\{runtime_env\[@\]\}" node .*$/gm,
      `/usr/bin/printf '%s\\n' '${childLaunchMarker}'`
    );
    for (const rejection of [
      {
        diagnostic: 'Worker bootstrap input is missing.',
        input: `${workerControlToken}\n`,
        privateValues: [workerControlToken],
      },
      {
        diagnostic: 'Worker bootstrap input is invalid.',
        input: `${workerControlToken}\nmalformed-private-slot\n`,
        privateValues: [workerControlToken, 'malformed-private-slot'],
      },
      {
        diagnostic: 'Worker bootstrap input is invalid.',
        input: `${workerControlToken}\n${'C'.repeat(44)}\n`,
        privateValues: [workerControlToken, 'C'.repeat(44)],
      },
      {
        diagnostic: 'Worker bootstrap input is invalid.',
        input: `${workerControlToken}\n${workerControlToken}\n`,
        privateValues: [workerControlToken],
      },
      {
        diagnostic: 'Worker bootstrap input has trailing data.',
        input: `${workerControlToken}\n${workerInferenceToken}\nprivate-extra-slot\n`,
        privateValues: [workerControlToken, workerInferenceToken, 'private-extra-slot'],
      },
      {
        diagnostic: 'Worker bootstrap input has trailing data.',
        input: `${workerControlToken}\n${workerInferenceToken}\nprivate-trailing-slot`,
        privateValues: [workerControlToken, workerInferenceToken, 'private-trailing-slot'],
      },
    ]) {
      const rejected = spawnSync(
        '/bin/bash',
        [
          '-c',
          rejectionLauncher,
          'openkit-worker-shim',
          '--package',
          '/openkit/config/package.json',
        ],
        {
          encoding: 'utf8',
          env: inherited,
          input: rejection.input,
        }
      );
      const outputAndError = `${rejected.stdout}${rejected.stderr}`;

      expect(rejected.error).toBeUndefined();
      expect(rejected.status).toBe(64);
      expect(rejected.stdout).toBe('');
      expect(rejected.stderr).toBe(`${rejection.diagnostic}\n`);
      expect(outputAndError).not.toContain(childLaunchMarker);
      for (const privateValue of rejection.privateValues) {
        expect(outputAndError).not.toContain(privateValue);
      }
    }

    expect(launcher).toContain('NODE_USE_ENV_PROXY=1');
    expect(launcher).toContain('OPENKIT_CONTROL_TOKEN_FD=3');
    expect(launcher).toContain(`exec 3<<<"\${worker_control_token}"`);
    expect(launcher).toContain('read -r worker_control_token');
    expect(launcher).toContain('read -r worker_inference_token');
    expect(launcher).toContain('trailing_input');
    expect(launcher).not.toContain(`\${OPENKIT_CONTROL_TOKEN:-}`);
    expect(launcher).not.toContain(`\${OPENKIT_WORKER_INFERENCE_TOKEN:-}`);
    for (const fixedDiagnostic of [
      'Worker bootstrap input is missing.',
      'Worker bootstrap input is invalid.',
      'Worker bootstrap input has trailing data.',
    ]) {
      expect(launcher).toContain(fixedDiagnostic);
    }
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
    ]) {
      expect(smoke).toContain(`command -v ${command}`);
    }
    expect(smoke).toContain('24.18.0');
    expect(smoke).toContain('Python 3.14.6');
    expect(smoke).toContain('0[.]11[.]30');
    expect(smoke).toContain('gh version 2.96.0');
    expect(smoke).toContain('10.33.3');
    expect(smoke).toContain('test ! -e /etc/openshell/policy.yaml');
    expect(smoke).toContain('find /sandbox /workspace -xdev -uid 0 -print -quit');
    expect(smoke).toContain('/sandbox/.venv');
  });

  it('passes the manifest target through local Docker builds', () => {
    const buildScript = readFileSync(buildImageScriptPath, 'utf8');

    expect(buildScript).toContain('read_optional_image_field target');
    expect(buildScript).toContain(`docker_args+=(--target "\${target}")`);
    expect(buildScript).toContain(`docker build "\${docker_args[@]}" "\${context}"`);
  });

  it('passes the manifest target through smoke and publish builds in release CI', () => {
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
  readonly runtime: string;
  readonly target: string;
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
