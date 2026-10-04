import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentEnvironmentPackageSchema, AuthoredAgentConfigSchema } from '@openkit/config-schema';
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

/** Pinned adapters selected independently on the shared deployment image. */
const workerImageContracts = [
  {
    id: 'worker-runtimes',
    manifest: 'codex.agent.jsonc',
    nativeBinary: '/usr/local/bin/codex',
    nativeVersion: '0.160.0',
    runtime: 'codex',
  },
  {
    id: 'worker-runtimes',
    manifest: 'opencode-server.agent.jsonc',
    nativeBinary: '/usr/local/bin/opencode',
    nativeVersion: '2.0.22',
    runtime: 'opencode',
  },
  {
    id: 'worker-runtimes',
    manifest: 'pi.agent.jsonc',
    nativeBinary: '/usr/local/bin/openkit-pi-runtime-host',
    nativeVersion: '1.0.2',
    runtime: 'pi',
  },
  {
    id: 'worker-runtimes',
    manifest: 'deepseek.agent.jsonc',
    nativeBinary: '/usr/local/bin/dsh',
    nativeVersion: '0.2.0-rc.2',
    runtime: 'deepseek',
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
  '/opt/openkit/venv/bin/python',
  '/opt/openkit/venv/bin/python3',
  '/opt/openkit/venv/bin/pip',
  '/opt/openkit/venv/bin/pip3',
] as const;

const canonicalWorkspaceRoots = [
  '/workspace/worktrees',
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
    expect(base).not.toHaveProperty('runtimes');
    expect(base).not.toHaveProperty('workerContract');
    expect(workers.map((worker) => worker.id)).toEqual(['worker-common', 'worker-runtimes']);
    expect(workers.find((worker) => worker.id === 'worker-runtimes')).toMatchObject({
      dockerfile: 'containers/workers/Dockerfile',
      runtimes: ['codex', 'pi', 'opencode', 'deepseek'],
      target: 'worker-runtimes',
    });
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
    expect(dockerfile).toContain(`uv venv --python "\${PYTHON_VERSION}" --seed /opt/openkit/venv`);
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
    expect(dockerfile).toContain('/usr/sbin/groupmod --new-name sandbox node');
    expect(dockerfile).toContain(
      '/usr/sbin/usermod --login sandbox --home /sandbox --shell /bin/bash node'
    );
    expect(commonRuntimeSetup).toContain('/openkit/sessions');
    expect(dockerfile).not.toContain('ln -s /sandbox/openkit /openkit');
    expect(dockerfile).toContain(
      'chown -R 1000:1000 /openkit /sandbox /tmp/openkit-bootstrap /workspace'
    );
    expect(workerCommonBuildWrites).not.toContain('/openkit/config/package.json');
    expect(workerCommonBuild).not.toMatch(/^(?:COPY|ADD)\s+.*\s+\/openkit\/config(?:\/|\s|$)/m);
    expect(dockerCommonSection(dockerfile)).toContain('USER 1000:1000');
    for (const { id } of workerImageContracts) {
      expect(dockerTargetSection(dockerfile, id)).toContain('USER 1000:1000');
    }
    expect(smoke).toContain('test -x /usr/local/bin/openkit-file-effect');
    for (const root of canonicalWorkspaceRoots) {
      expect(commonRuntimeSetup).toContain(root);
      expect(smoke).toContain(root);
    }
  });

  it('declares the inherited persistent layout and keeps control and base Python outside it', () => {
    const dockerfile = readFileSync(sharedDockerfilePath, 'utf8');
    const common = dockerCommonSection(dockerfile);

    expect(common).toContain('LABEL org.openkit.storage.family="openkit-worker"');
    expect(common).toContain('LABEL org.openkit.storage.version="1"');
    expect(common).toContain('VOLUME ["/workspace", "/sandbox"]');
    expect(common).toContain('WORKDIR /tmp/openkit-bootstrap');
    expect(common).toContain('chmod 0700 /tmp/openkit-bootstrap');
    expect(common).toContain('USER 1000:1000');
    expect(common).toContain('VIRTUAL_ENV="/opt/openkit/venv"');
    expect(common).toContain('BASH_ENV="/opt/openkit/.bashrc"');
    expect(common).toContain('TMPDIR="/tmp/openkit-bootstrap"');
    expect(common).not.toContain('VIRTUAL_ENV="/sandbox/.venv"');
    expect(common).not.toContain('WORKDIR /workspace');
    for (const { id } of workerImageContracts) {
      expect(dockerTargetSection(dockerfile, id)).toContain('USER 1000:1000');
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

    expect(image).toMatchObject({ runtimes: ['codex', 'pi', 'opencode', 'deepseek'], target: id });
    expect(declaredRuntimes).toEqual(['codex', 'pi', 'opencode', 'deepseek']);
    expect(targetSection).toContain(
      'LABEL org.openkit.worker.runtimes="codex,pi,opencode,deepseek"'
    );
    expect(targetSection).toContain(`COPY containers/${id}/smoke.sh`);
    expect(targetSection).toContain('USER 1000:1000');
    expect(agentManifest.runtime).toMatchObject({
      adapter: runtime,
      image: { kind: 'reference', ref: image?.localTag },
      version: nativeVersion,
    });
    expect(agentManifest.runtime.binaries.map((binary) => binary.path)).toContain(nativeBinary);
    expect(targetSection).not.toContain('org.openkit.worker.runtime=');
  });

  it('keeps the image version manifest aligned with adapter packages and validates all four templates', () => {
    const versions = JSON.parse(
      readFileSync(join(repoRoot, 'containers/worker-runtimes/versions.json'), 'utf8')
    );
    const shim = JSON.parse(
      readFileSync(join(repoRoot, 'packages/worker-shim/package.json'), 'utf8')
    );
    const host = JSON.parse(
      readFileSync(join(repoRoot, 'packages/pi-runtime-host/package.json'), 'utf8')
    );
    for (const runtime of ['codex', 'opencode', 'deepseek']) {
      expect(versions[runtime].version).toBe(shim.devDependencies[versions[runtime].package]);
    }
    expect(versions.opencode.client.version).toBe(shim.devDependencies['@opencode/client']);
    expect(versions.deepseek.acpClient.version).toBe(shim.dependencies['@agentclientprotocol/sdk']);
    expect(versions.pi.version).toBe(host.dependencies['@earendil-works/pi-coding-agent']);
    for (const contract of workerImageContracts) {
      expect(
        AuthoredAgentConfigSchema.safeParse(readAgentManifest(contract.manifest)).success
      ).toBe(true);
    }
  });

  it('reads a complete AEP fixture for each adapter in the deployed smoke', () => {
    const fixture = JSON.parse(
      readFileSync(join(repoRoot, 'containers/worker-runtimes/smoke-package.json'), 'utf8')
    );
    for (const { runtime, nativeVersion, nativeBinary } of workerImageContracts) {
      const aep = structuredClone(fixture);
      aep.agent.runtimeKind = runtime;
      aep.agent.runtimeVersion = nativeVersion;
      aep.control.adapter.targetRuntime = runtime;
      aep.runtime.binaries[1] = { id: runtime, path: nativeBinary };
      expect(AgentEnvironmentPackageSchema.safeParse(aep).success).toBe(true);
      expect(aep.extensions.openkit.sessionWorkspace.layout.slots).toContainEqual({
        kind: 'worktree',
        access: 'read-write',
        path: '/workspace/worktrees/image-smoke',
      });
    }
    expect(
      dockerTargetSection(readFileSync(sharedDockerfilePath, 'utf8'), 'worker-runtimes')
    ).toContain(
      'COPY containers/worker-runtimes/smoke-package.json /usr/local/lib/openkit/image-smoke-package.json'
    );
  });

  it('imports the smoke AEP before opening each native resident', () => {
    const smoke = readFileSync(join(repoRoot, 'containers/worker-runtimes/smoke.sh'), 'utf8');
    expect(smoke.indexOf('await writeFile(packagePath,')).toBeGreaterThan(-1);
    expect(smoke.indexOf('await writeFile(packagePath,')).toBeLessThan(
      smoke.indexOf("send('session.open'")
    );
  });

  it('deploys patched Pi separately and installs OpenCode and DeepSeek on the shim resolution path', () => {
    const dockerfile = readFileSync(sharedDockerfilePath, 'utf8');
    const common = dockerCommonSection(dockerfile);
    const deployment = dockerTargetSection(dockerfile, 'worker-runtimes');
    expect(dockerfile).toContain('pnpm --filter @openkit/pi-runtime-host deploy --prod --legacy');
    expect(deployment).toContain('COPY --from=worker-shim-builder /deploy/pi-runtime-host/');
    expect(deployment).toContain(`@opencode/cli@\${OPENCODE_VERSION}`);
    expect(deployment).toContain(`@opencode/client@\${OPENCODE_VERSION}`);
    expect(deployment).toContain(`@deepseek-ai/dsh@\${DEEPSEEK_VERSION}`);
    expect(deployment).toContain('--prefix /usr/local/lib/openkit/runtime-supply');
    expect(deployment).toContain('test ! -e /etc/opencode');
    expect(deployment).toContain(
      'ln -s /usr/local/lib/openkit/pi-runtime-host/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js /usr/local/bin/pi'
    );
    expect(common).not.toContain('/deploy/pi-runtime-host/');
    expect(deployment).not.toContain('pi-mcp-adapter');
    expect(deployment).not.toContain('allow-anthropic-api-key');
  });

  it('keeps image smoke on the static four-adapter registry without provider work', () => {
    const smoke = readFileSync(join(repoRoot, 'containers', 'worker-runtimes', 'smoke.sh'), 'utf8');
    expect(smoke).toContain('WORKER_ADAPTERS');
    expect(smoke).toContain('WorkerHarness');
    expect(smoke).toContain("'session.open'");
    expect(smoke).toContain("'session.inspect'");
    expect(smoke).toContain("'session.close'");
    expect(smoke).not.toContain("'turn.start'");
    expect(smoke).toContain('createToolSearchExtension');
    expect(smoke).toContain('onConnectionState');
  });

  it('keeps root-owned build state out of the writable worker home', () => {
    const dockerfile = readFileSync(sharedDockerfilePath, 'utf8');
    const smoke = readFileSync(commonSmokePath, 'utf8');

    for (const { id } of workerImageContracts) {
      const targetSection = dockerTargetSection(dockerfile, id);

      expect(targetSection).toContain('NPM_CONFIG_CACHE=/tmp/npm-cache');
      expect(targetSection).toContain('rm -rf');
    }
    expect(dockerTargetSection(dockerfile, 'worker-runtimes')).toContain(
      'CODEX_HOME=/tmp/codex-home'
    );
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
      HTTP_PROXY: 'http://proxy.invalid:8080',
      HTTPS_PROXY: 'http://proxy.invalid:8080',
      http_proxy: 'http://proxy.invalid:8080',
      https_proxy: 'http://proxy.invalid:8080',
      grpc_proxy: 'http://proxy.invalid:8080',
      NODE_USE_ENV_PROXY: '1',
      NODE_EXTRA_CA_CERTS: '/etc/openshell-tls/openshell-ca.pem',
      DENO_CERT: '/etc/openshell-tls/openshell-ca.pem',
      SSL_CERT_FILE: '/etc/openshell-tls/ca-bundle.pem',
      REQUESTS_CA_BUNDLE: '/etc/openshell-tls/ca-bundle.pem',
      CURL_CA_BUNDLE: '/etc/openshell-tls/ca-bundle.pem',
      GIT_SSL_CAINFO: '/etc/openshell-tls/ca-bundle.pem',
      HOME: '/sandbox',
      NO_PROXY: '127.0.0.1,localhost',
      PATH: '/opt/openkit/venv/bin:/usr/local/bin:/usr/bin:/bin',
      TEMP: '/tmp/unadmitted-temp',
      TMP: '/tmp/unadmitted-tmp',
      TMPDIR: '/tmp/unadmitted-tmpdir',
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

    for (const name of [
      'ALL_PROXY',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'NO_PROXY',
      'http_proxy',
      'https_proxy',
      'no_proxy',
      'grpc_proxy',
      'NODE_USE_ENV_PROXY',
      'NODE_EXTRA_CA_CERTS',
      'DENO_CERT',
      'SSL_CERT_FILE',
      'REQUESTS_CA_BUNDLE',
      'CURL_CA_BUNDLE',
      'GIT_SSL_CAINFO',
    ] as const)
      expect.soft(environment[name], name).toBe(inherited[name]);
    expect(environment.BASH_ENV).toBe('/opt/openkit/.bashrc');
    expect(environment.ENV).toBe('/opt/openkit/.bashrc');
    expect(environment.VIRTUAL_ENV).toBe('/opt/openkit/venv');
    expect(environment.TEMP).toBe('/tmp/openkit-bootstrap');
    expect(environment.TMP).toBe('/tmp/openkit-bootstrap');
    expect(environment.TMPDIR).toBe('/tmp/openkit-bootstrap');
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
    expect(smoke).toContain('/opt/openkit/venv');
    expect(smoke).toContain('/tmp/openkit-bootstrap');
    expect(smoke).toContain('test ! -L /openkit');
    expect(smoke).toContain('.openkit-image-smoke-unknown');
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
    expect(common).toContain('USER 1000:1000');
    expect(common).not.toContain('USER root');
  });

  it('regains root only in deployment stages to install the native runtime, then returns to sandbox', () => {
    const dockerfile = readFileSync(sharedDockerfilePath, 'utf8');

    for (const { id } of workerImageContracts) {
      const targetSection = dockerTargetSection(dockerfile, id);

      expect(targetSection).toMatch(/USER root[\s\S]*USER 1000:1000/);
      expect(targetSection.match(/USER root/g)).toHaveLength(1);
      expect(targetSection.match(/USER 1000:1000/g)).toHaveLength(1);
    }
  });

  it('keeps catalog worker smoke runs offline while preserving app smoke networking', () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-smoke-egress-'));
    try {
      for (const id of ['worker-common', 'worker-runtimes', 'app']) {
        const log = join(root, `${id}.argv`);
        const result = spawnSync(
          'bash',
          [
            '-c',
            `docker() {
  if [[ "$1" == run ]]; then
    printf '%s\\0' "$@" >> "$DOCKER_ARGV_LOG"
    printf '\\n' >> "$DOCKER_ARGV_LOG"
  fi
}
export -f docker
bash "$SMOKE_HELPER" "$IMAGE_ID" "openkit/$IMAGE_ID:fixture"`,
          ],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              DOCKER_ARGV_LOG: log,
              IMAGE_ID: id,
              SMOKE_HELPER: join(repoRoot, 'scripts/docker/smoke-image.sh'),
            },
          }
        );
        expect(result.status, result.stderr).toBe(0);
        const runs = readFileSync(log, 'utf8').trim().split('\n');
        expect(runs.length).toBe(id === 'worker-common' ? 2 : 1);
        for (const run of runs) {
          const args = run.split('\0');
          expect(args.includes('--network=none')).toBe(id !== 'app');
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
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
    for (const runtime of ['codex', 'pi', 'opencode', 'dsh']) {
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
  readonly runtimes?: readonly string[];
  readonly smoke: string;
  readonly target: string;
  readonly workerContract?: string;
}

/**
 * Returns the catalog-declared runtime set for one worker image.
 *
 * `runtimes` metadata declares the installed set. Omission is the empty set.
 *
 * @param entry Worker catalog entry, when present.
 * @returns Declared runtime names.
 */
function catalogDeclaredRuntimeSet(entry: WorkerImageEntry | undefined): string[] {
  return [...(entry?.runtimes ?? [])];
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
