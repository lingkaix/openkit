// openkit-test-platform: posix
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  initializeEmptyWorkspaceSlot,
  materializeWorkspaceGitInputs,
  type WorkspaceGitInput,
} from './workspace-git.js';

describe('workspace Git materialization', () => {
  it('initializes a contained source-less slot and preserves retained bytes while refusing root aliases', async () => {
    const root = mkdtempSync(join(tmpdir(), 'n6-empty-slot-'));
    const target = join(root, 'worktrees', 'empty');
    await initializeEmptyWorkspaceSlot(root, target);
    expect(readdirSync(target)).toEqual([]);
    writeFileSync(join(target, 'worker.txt'), 'retained');
    await initializeEmptyWorkspaceSlot(root, target);
    expect(readFileSync(join(target, 'worker.txt'), 'utf8')).toBe('retained');
    for (const outside of [root, dirname(root), join(root, '..', 'foreign')]) {
      await expect(initializeEmptyWorkspaceSlot(root, outside)).rejects.toThrow(
        'Empty workspace target escapes its root'
      );
    }
    const linked = join(root, 'linked');
    symlinkSync(target, linked, 'dir');
    await expect(initializeEmptyWorkspaceSlot(root, linked)).rejects.toThrow();
    expect(readFileSync(join(target, 'worker.txt'), 'utf8')).toBe('retained');
  });
  it.skipIf(process.platform === 'win32')(
    'rejects a symbolic-link workspace root without writing through it',
    async () => {
      const boundaryDir = mkdtempSync(join(tmpdir(), 'openkit-workspace-root-link-'));
      const outsideDir = join(boundaryDir, 'outside');
      const workspaceRoot = join(boundaryDir, 'workspace');
      const sessionDir = join(boundaryDir, 'session');
      const remote = createBareGitRemote({ 'README.md': '# Exact remote source\n' });
      mkdirSync(outsideDir);
      mkdirSync(sessionDir);
      writeFixtureFile(outsideDir, 'sentinel', 'outside must stay unchanged\n');
      symlinkSync(outsideDir, workspaceRoot, 'dir');
      const input = createWorkspaceGitInput(
        join(workspaceRoot, 'worktrees', 'main'),
        remote.commit,
        remote.path
      );
      const before = readdirSync(outsideDir);
      let rejection: unknown = null;

      try {
        await materializeWorkspaceGitInputs([input], workspaceRoot, sessionDir);
      } catch (error) {
        rejection = error;
      }

      expect.soft(rejection).toBeInstanceOf(Error);
      expect(readdirSync(outsideDir)).toEqual(before);
      expect(readFileSync(join(outsideDir, 'sentinel'), 'utf8')).toBe(
        'outside must stay unchanged\n'
      );
    }
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a target ancestor symbolic-link before creating an outside descendant',
    async () => {
      const boundaryDir = mkdtempSync(join(tmpdir(), 'openkit-workspace-ancestor-link-'));
      const outsideDir = join(boundaryDir, 'outside');
      const workspaceRoot = join(boundaryDir, 'workspace');
      const sessionDir = join(boundaryDir, 'session');
      const remote = createBareGitRemote({ 'README.md': '# Exact remote source\n' });
      mkdirSync(outsideDir);
      mkdirSync(workspaceRoot);
      mkdirSync(sessionDir);
      writeFixtureFile(outsideDir, 'sentinel', 'outside must stay unchanged\n');
      symlinkSync(outsideDir, join(workspaceRoot, 'worktrees'), 'dir');
      const input = createWorkspaceGitInput(
        join(workspaceRoot, 'worktrees', 'new-parent', 'main'),
        remote.commit,
        remote.path
      );
      const before = readdirSync(outsideDir);

      await expect(
        materializeWorkspaceGitInputs([input], workspaceRoot, sessionDir)
      ).rejects.toThrow(/escapes|root/i);
      expect(readdirSync(outsideDir)).toEqual(before);
      expect(readFileSync(join(outsideDir, 'sentinel'), 'utf8')).toBe(
        'outside must stay unchanged\n'
      );
    }
  );

  it('materializes an exact detached clean commit from a validated local Git transport', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-workspace-materialize-'));
    const workspaceRoot = join(root, 'workspace');
    const sessionDir = join(root, 'session');
    const target = join(workspaceRoot, 'worktrees', 'main');
    const remote = createBareGitRemote({ 'README.md': '# Exact remote source\n' });
    mkdirSync(sessionDir);
    const input = createWorkspaceGitInput(target, remote.commit, remote.path);

    await expect(
      materializeWorkspaceGitInputs([input], workspaceRoot, sessionDir)
    ).resolves.toEqual({
      commit: remote.commit,
      tree: gitText(remote.path, ['rev-parse', `${remote.commit}^{tree}`]),
    });

    expect(gitText(target, ['rev-parse', 'HEAD'])).toBe(remote.commit);
    expect(gitText(target, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD');
    expect(gitText(target, ['status', '--porcelain'])).toBe('');
    expect(gitText(target, ['config', '--get', 'remote.origin.url'])).toBe(remote.path);
  });

  it('initializes an empty work slot precreated by the sandbox filesystem policy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-workspace-empty-slot-'));
    const workspaceRoot = join(root, 'workspace');
    const sessionDir = join(root, 'session');
    const target = join(workspaceRoot, 'worktrees', 'main');
    const remote = createBareGitRemote({ 'README.md': '# Exact remote source\n' });
    mkdirSync(sessionDir);
    mkdirSync(target, { recursive: true });
    const input = createWorkspaceGitInput(target, remote.commit, remote.path);

    await expect(
      materializeWorkspaceGitInputs([input], workspaceRoot, sessionDir)
    ).resolves.toEqual({
      commit: remote.commit,
      tree: gitText(remote.path, ['rev-parse', `${remote.commit}^{tree}`]),
    });
    expect(gitText(target, ['rev-parse', 'HEAD'])).toBe(remote.commit);
    expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('# Exact remote source\n');
  });

  it.each([
    'unknown.txt',
    '.hidden',
    '.git',
  ])('preserves a populated uninitialized slot containing %s', async (entry) => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-workspace-populated-slot-'));
    const workspaceRoot = join(root, 'workspace');
    const sessionDir = join(root, 'session');
    const target = join(workspaceRoot, 'worktrees', 'main');
    const remote = createBareGitRemote({ 'README.md': '# Exact remote source\n' });
    mkdirSync(sessionDir);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, entry), 'preserve these bytes');
    const input = createWorkspaceGitInput(target, remote.commit, remote.path);

    await expect(materializeWorkspaceGitInputs([input], workspaceRoot, sessionDir)).rejects.toThrow(
      'Retained Git workspace baseline is unavailable.'
    );
    expect(readdirSync(target)).toEqual([entry]);
    expect(readFileSync(join(target, entry), 'utf8')).toBe('preserve these bytes');
  });

  it.skipIf(process.platform === 'win32')(
    'preserves only the OpenShell Git transport environment for Git subprocesses',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'openkit-workspace-git-environment-'));
      const wrapperDir = join(root, 'bin');
      const observedEnvironmentPath = join(root, 'git-environment.json');
      const workspaceRoot = join(root, 'workspace');
      const sessionDir = join(root, 'session');
      const target = join(workspaceRoot, 'worktrees', 'main');
      const remote = createBareGitRemote({ 'README.md': '# Exact remote source\n' });
      const originalPath = process.env.PATH ?? '';
      const realGitPath = originalPath
        .split(delimiter)
        .map((entry) => join(entry, 'git'))
        .find((candidate) => existsSync(candidate));
      if (!realGitPath) {
        throw new Error('Workspace Git environment fixture requires Git on PATH.');
      }

      const proxyEnvironment = {
        ALL_PROXY: 'http://127.0.0.1:19001',
        HTTPS_PROXY: 'http://127.0.0.1:19002',
        HTTP_PROXY: 'http://127.0.0.1:19003',
        NO_PROXY: 'localhost,127.0.0.1',
        http_proxy: 'http://127.0.0.1:19004',
        https_proxy: 'http://127.0.0.1:19005',
        no_proxy: '127.0.0.1,localhost',
      };
      const environmentCanaries = {
        CURL_CA_BUNDLE: '/openkit/ca/curl.pem',
        DENO_CERT: '/openkit/ca/deno.pem',
        GITHUB_TOKEN: 'credential-canary-must-not-leak',
        GIT_SSL_CAINFO: '/ambient/ca/must-not-win.pem',
        NODE_EXTRA_CA_CERTS: '/openkit/ca/node.pem',
        OPENKIT_UNRELATED_CANARY: 'unrelated-canary-must-not-leak',
        REQUESTS_CA_BUNDLE: '/openkit/ca/python.pem',
        SSL_CERT_FILE: '/openkit/ca/tls.pem',
        all_proxy: 'http://127.0.0.1:19006',
      };
      const observedKeys = [...Object.keys(proxyEnvironment), ...Object.keys(environmentCanaries)];
      const previousEnvironment = Object.fromEntries(
        [...observedKeys, 'PATH'].map((key) => [key, process.env[key]])
      );
      mkdirSync(wrapperDir);
      mkdirSync(sessionDir);
      writeFileSync(
        join(wrapperDir, 'git'),
        `#!${process.execPath}\n` +
          `const { spawnSync } = require('node:child_process');\n` +
          `const { writeFileSync } = require('node:fs');\n` +
          `const keys = ${JSON.stringify(observedKeys)};\n` +
          `writeFileSync(${JSON.stringify(observedEnvironmentPath)}, JSON.stringify(Object.fromEntries(keys.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]))));\n` +
          `const result = spawnSync(${JSON.stringify(realGitPath)}, process.argv.slice(2), { env: process.env, stdio: 'inherit' });\n` +
          `if (result.error) throw result.error;\n` +
          `process.exit(result.status ?? 1);\n`
      );
      chmodSync(join(wrapperDir, 'git'), 0o755);

      try {
        Object.assign(process.env, proxyEnvironment, environmentCanaries);
        process.env.PATH = `${wrapperDir}${delimiter}${originalPath}`;
        const input = createWorkspaceGitInput(target, remote.commit, remote.path);

        await expect(
          materializeWorkspaceGitInputs([input], workspaceRoot, sessionDir)
        ).resolves.toEqual({
          commit: remote.commit,
          tree: gitText(remote.path, ['rev-parse', `${remote.commit}^{tree}`]),
        });

        const observedEnvironment = JSON.parse(
          readFileSync(observedEnvironmentPath, 'utf8')
        ) as Record<string, string>;
        expect(observedEnvironment).toEqual({
          ...proxyEnvironment,
          CURL_CA_BUNDLE: environmentCanaries.SSL_CERT_FILE,
          GIT_SSL_CAINFO: environmentCanaries.SSL_CERT_FILE,
        });
        expect(observedEnvironment.CURL_CA_BUNDLE).not.toBe(environmentCanaries.CURL_CA_BUNDLE);
        expect(observedEnvironment).not.toHaveProperty('DENO_CERT');
        expect(observedEnvironment).not.toHaveProperty('GITHUB_TOKEN');
        expect(observedEnvironment).not.toHaveProperty('NODE_EXTRA_CA_CERTS');
        expect(observedEnvironment).not.toHaveProperty('OPENKIT_UNRELATED_CANARY');
        expect(observedEnvironment).not.toHaveProperty('REQUESTS_CA_BUNDLE');
        expect(observedEnvironment).not.toHaveProperty('SSL_CERT_FILE');
        expect(observedEnvironment).not.toHaveProperty('all_proxy');
      } finally {
        for (const [key, value] of Object.entries(previousEnvironment)) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
      }
    }
  );

  it('reuses an exact retained worktree without deleting tracked, untracked, or ignored bytes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-workspace-rematerialize-'));
    const workspaceRoot = join(root, 'workspace');
    const sessionDir = join(root, 'session');
    const target = join(workspaceRoot, 'worktrees', 'main');
    const remote = createBareGitRemote({ 'README.md': '# Exact remote source\n' });
    mkdirSync(sessionDir);
    const input = createWorkspaceGitInput(target, remote.commit, remote.path);
    await materializeWorkspaceGitInputs([input], workspaceRoot, sessionDir);
    writeFixtureFile(target, '.gitignore', 'temp/\n');
    writeFixtureFile(target, 'README.md', '# Dirty prior Turn\n');
    writeFixtureFile(target, 'untracked.txt', 'retain me\n');
    writeFixtureFile(target, 'temp/unknown.bin', Buffer.from([0, 1, 2, 3]));

    await expect(
      materializeWorkspaceGitInputs([input], workspaceRoot, sessionDir)
    ).resolves.toBeNull();

    expect(gitText(target, ['rev-parse', 'HEAD'])).toBe(remote.commit);
    expect(gitText(target, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD');
    expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('# Dirty prior Turn\n');
    expect(readFileSync(join(target, 'untracked.txt'), 'utf8')).toBe('retain me\n');
    expect(readFileSync(join(target, 'temp/unknown.bin'))).toEqual(Buffer.from([0, 1, 2, 3]));
  });

  it('rejects a retained worktree from another exact source without changing its bytes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-workspace-source-conflict-'));
    const workspaceRoot = join(root, 'workspace');
    const sessionDir = join(root, 'session');
    const target = join(workspaceRoot, 'worktrees', 'main');
    const first = createBareGitRemote({ 'README.md': '# First source\n' });
    mkdirSync(sessionDir);
    const input = createWorkspaceGitInput(target, first.commit, first.path);
    await materializeWorkspaceGitInputs([input], workspaceRoot, sessionDir);
    git(target, ['remote', 'set-url', 'origin', 'poison']);
    git(target, ['config', `url.${first.path}.insteadOf`, 'poison']);
    writeFixtureFile(target, 'unknown.bin', Buffer.from([9, 8, 7]));

    await expect(materializeWorkspaceGitInputs([input], workspaceRoot, sessionDir)).rejects.toThrow(
      /source|origin/i
    );

    expect(gitText(target, ['rev-parse', 'HEAD'])).toBe(first.commit);
    expect(gitText(target, ['remote', 'get-url', 'origin'])).toBe(first.path);
    expect(gitText(target, ['config', '--local', '--get', 'remote.origin.url'])).toBe('poison');
    expect(gitText(target, ['config', '--local', '--get', `url.${first.path}.insteadOf`])).toBe(
      'poison'
    );
    expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('# First source\n');
    expect(readFileSync(join(target, 'unknown.bin'))).toEqual(Buffer.from([9, 8, 7]));
  });

  it('preserves a retained worker commit rather than resetting to the original accepted source', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-workspace-baseline-conflict-'));
    const workspaceRoot = join(root, 'workspace');
    const sessionDir = join(root, 'session');
    const target = join(workspaceRoot, 'worktrees', 'main');
    const remote = createBareGitRemote({ 'README.md': '# Exact source\n' });
    mkdirSync(sessionDir);
    await materializeWorkspaceGitInputs(
      [createWorkspaceGitInput(target, remote.commit, remote.path)],
      workspaceRoot,
      sessionDir
    );
    writeFixtureFile(target, 'unknown.bin', Buffer.from([6, 5, 4]));
    git(target, [
      '-c',
      'user.name=Worker',
      '-c',
      'user.email=worker@example.com',
      'add',
      'unknown.bin',
    ]);
    git(target, [
      '-c',
      'user.name=Worker',
      '-c',
      'user.email=worker@example.com',
      'commit',
      '-m',
      'worker commit',
    ]);
    const workerCommit = gitText(target, ['rev-parse', 'HEAD']);

    await expect(
      materializeWorkspaceGitInputs(
        [createWorkspaceGitInput(target, remote.commit, remote.path)],
        workspaceRoot,
        sessionDir
      )
    ).resolves.toBeNull();

    expect(gitText(target, ['rev-parse', 'HEAD'])).toBe(workerCommit);
    expect(readFileSync(join(target, 'unknown.bin'))).toEqual(Buffer.from([6, 5, 4]));
  });

  it('preserves an incomplete first initialization for explicit reconciliation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-workspace-incomplete-init-'));
    const workspaceRoot = join(root, 'workspace');
    const sessionDir = join(root, 'session');
    const target = join(workspaceRoot, 'worktrees', 'main');
    mkdirSync(sessionDir);
    const input = createWorkspaceGitInput(target, '1'.repeat(40), join(root, 'missing-remote.git'));

    await expect(materializeWorkspaceGitInputs([input], workspaceRoot, sessionDir)).rejects.toThrow(
      /fetch|initialization|source/i
    );

    expect(existsSync(target)).toBe(true);
    expect(existsSync(join(target, '.git'))).toBe(true);
  });

  it('checks out an advertised commit when the remote refuses a raw object want', async () => {
    const remote = createBareGitRemote({ 'README.md': '# Advertised source\n' });
    const root = mkdtempSync(join(tmpdir(), 'openkit-workspace-advertised-fetch-'));
    const workspaceRoot = join(root, 'workspace');
    const sessionDir = join(root, 'session');
    const target = join(workspaceRoot, 'worktrees', 'main');
    mkdirSync(sessionDir);

    await withShaRefusingGit(root, false, () =>
      materializeWorkspaceGitInputs(
        [createWorkspaceGitInput(target, remote.commit, remote.path)],
        workspaceRoot,
        sessionDir
      )
    );

    expect(gitText(target, ['rev-parse', 'HEAD'])).toBe(remote.commit);
    expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('# Advertised source\n');
  });

  it('checks out a tag-only commit when the remote refuses a raw object want', async () => {
    const remote = createTagOnlyGitRemote();
    const root = mkdtempSync(join(tmpdir(), 'openkit-workspace-tag-fetch-'));
    const workspaceRoot = join(root, 'workspace');
    const sessionDir = join(root, 'session');
    const target = join(workspaceRoot, 'worktrees', 'main');
    mkdirSync(sessionDir);

    await withShaRefusingGit(root, false, () =>
      materializeWorkspaceGitInputs(
        [createWorkspaceGitInput(target, remote.commit, remote.path)],
        workspaceRoot,
        sessionDir
      )
    );

    expect(gitText(target, ['rev-parse', 'HEAD'])).toBe(remote.commit);
    expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('# Tag only\n');
  });

  it('keeps an ordinary fetch failure when the advertised fallback fails', async () => {
    const remote = createBareGitRemote({ 'README.md': '# Present source\n' });
    const root = mkdtempSync(join(tmpdir(), 'openkit-workspace-fallback-failed-'));
    const workspaceRoot = join(root, 'workspace');
    const sessionDir = join(root, 'session');
    const target = join(workspaceRoot, 'worktrees', 'main');
    mkdirSync(sessionDir);

    await expect(
      withShaRefusingGit(root, true, () =>
        materializeWorkspaceGitInputs(
          [createWorkspaceGitInput(target, remote.commit, remote.path)],
          workspaceRoot,
          sessionDir
        )
      )
    ).rejects.toThrow('Remote Git commit fetch failed.');

    expect(existsSync(join(target, '.git'))).toBe(true);
    expect(existsSync(join(target, 'README.md'))).toBe(false);
  });

  it('checks out an advertised commit when the direct fetch fails with an unrecognized error', async () => {
    const remote = createBareGitRemote({ 'README.md': '# Unrecognized refusal\n' });
    const root = mkdtempSync(join(tmpdir(), 'openkit-workspace-unrecognized-fetch-'));
    const workspaceRoot = join(root, 'workspace');
    const sessionDir = join(root, 'session');
    const target = join(workspaceRoot, 'worktrees', 'main');
    const logPath = join(root, 'git-invocations.log');
    mkdirSync(sessionDir);

    await withScriptedGit(root, logPath, { shaFetch: 'unrecognized' }, () =>
      materializeWorkspaceGitInputs(
        [createWorkspaceGitInput(target, remote.commit, remote.path)],
        workspaceRoot,
        sessionDir
      )
    );

    expect(gitText(target, ['rev-parse', 'HEAD'])).toBe(remote.commit);
    expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('# Unrecognized refusal\n');
    expect(readFileSync(logPath, 'utf8')).toContain('refs/heads/*');
    const fetches = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[])
      .filter((args) => args.includes('fetch'));
    expect(fetches).toHaveLength(2);
    for (const args of fetches) {
      expect(args.indexOf('http.version=HTTP/1.1')).toBeGreaterThanOrEqual(0);
      expect(args.indexOf('http.version=HTTP/1.1')).toBeLessThan(args.indexOf('fetch'));
    }
  });

  it('does not fetch advertised refs after a direct fetch timeout', async () => {
    const remote = createBareGitRemote({ 'README.md': '# Timeout source\n' });
    const root = mkdtempSync(join(tmpdir(), 'openkit-workspace-fetch-timeout-'));
    const workspaceRoot = join(root, 'workspace');
    const sessionDir = join(root, 'session');
    const target = join(workspaceRoot, 'worktrees', 'main');
    const logPath = join(root, 'git-invocations.log');
    mkdirSync(sessionDir);
    const previousTimeout = process.env.OPENKIT_WORKER_GIT_TIMEOUT_MS;
    process.env.OPENKIT_WORKER_GIT_TIMEOUT_MS = '200';
    writeFileSync(logPath, '');
    let observeFetch: () => void = () => {};
    const fetchStarted = new Promise<void>((resolve) => {
      observeFetch = resolve;
    });
    const watcher = watch(logPath, () => {
      const invocations = readFileSync(logPath, 'utf8');
      if (invocations.includes('"fixture.fetch-hanging"')) {
        observeFetch();
      }
    });
    // Advance the deadline only after real setup and the fixture's hanging-fetch handshake.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    try {
      const materialization = withScriptedGit(
        root,
        logPath,
        { shaFetch: 'hang-after-refusal' },
        () =>
          materializeWorkspaceGitInputs(
            [createWorkspaceGitInput(target, remote.commit, remote.path)],
            workspaceRoot,
            sessionDir
          )
      );
      await Promise.race([fetchStarted, materialization]);
      const timeoutResult = expect(materialization).rejects.toMatchObject({
        message: 'Remote Git commit fetch transport failed.',
        explanation: {
          code: 'git_fetch_transport_failed',
          subprocess: 'timeout',
          httpStatus: null,
        },
      });
      await vi.advanceTimersByTimeAsync(200);
      await timeoutResult;
    } finally {
      watcher.close();
      vi.useRealTimers();
      if (previousTimeout === undefined) {
        delete process.env.OPENKIT_WORKER_GIT_TIMEOUT_MS;
      } else {
        process.env.OPENKIT_WORKER_GIT_TIMEOUT_MS = previousTimeout;
      }
    }

    const fetches = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[])
      .filter((args) => args.includes('fetch'));
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).toContain(remote.commit);
    expect(fetches[0]).not.toContain('+refs/heads/*:refs/remotes/origin/*');
    expect(existsSync(join(target, '.git'))).toBe(true);
    expect(existsSync(join(target, 'README.md'))).toBe(false);
  });

  it('keeps a fetch failure when object verification fails after a successful fallback', async () => {
    const remote = createBareGitRemote({ 'README.md': '# Present source\n' });
    const root = mkdtempSync(join(tmpdir(), 'openkit-workspace-object-check-'));
    const workspaceRoot = join(root, 'workspace');
    const sessionDir = join(root, 'session');
    const target = join(workspaceRoot, 'worktrees', 'main');
    mkdirSync(sessionDir);

    await expect(
      withScriptedGit(
        root,
        join(root, 'git-invocations.log'),
        { catFile: 'fail', shaFetch: 'unrecognized' },
        () =>
          materializeWorkspaceGitInputs(
            [createWorkspaceGitInput(target, remote.commit, remote.path)],
            workspaceRoot,
            sessionDir
          )
      )
    ).rejects.toThrow('Remote Git commit fetch failed.');

    expect(existsSync(join(target, '.git'))).toBe(true);
    expect(existsSync(join(target, 'README.md'))).toBe(false);
  });

  it.each([
    401, 403,
  ])('retains HTTP %s without attributing it to sandbox policy', async (status) => {
    const remote = createBareGitRemote({ 'README.md': '# refused\n' });
    const root = mkdtempSync(join(tmpdir(), 'openkit-http-refusal-'));
    const sessionDir = join(root, 'session');
    const workspaceRoot = join(root, 'workspace');
    const target = join(workspaceRoot, 'worktrees', 'main');
    mkdirSync(sessionDir);
    const failure = await withScriptedGit(
      root,
      join(root, 'git.log'),
      {
        shaFetch: 'tls',
        advertisedStderr: `fatal: unable to access 'https://canary-secret@example.invalid/private?canary-secret': The requested URL returned error: ${status}\n`,
      },
      () =>
        materializeWorkspaceGitInputs(
          [createWorkspaceGitInput(target, remote.commit, remote.path)],
          workspaceRoot,
          sessionDir
        )
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      message: 'Remote Git commit fetch HTTP refused.',
      explanation: {
        code: 'git_fetch_http_refused',
        httpStatus: status,
        subprocess: 'exit',
        enforcement: 'unavailable',
        evidence: { availability: 'partial', outputTruncated: false },
      },
    });
    expect(JSON.stringify(failure)).not.toContain('canary-secret');
    expect(existsSync(join(target, '.git'))).toBe(true);
  });

  it.each([
    {
      stderr: `${'x'.repeat(4096 - 'the requested url returned error: 403'.length)}the requested url returned error: 4030\n`,
      code: 'git_fetch_failed',
      truncated: true,
    },
    {
      stderr: `${'x'.repeat(4095 - 'the requested url returned error: 403'.length)}the requested url returned error: 403\ntrailing`,
      code: 'git_fetch_http_refused',
      truncated: true,
    },
    { stderr: 'unknown canary-secret failure', code: 'git_fetch_failed', truncated: false },
    {
      stderr: 'fatal: SSL certificate problem canary-secret',
      code: 'git_fetch_tls_failed',
      truncated: false,
    },
    {
      stderr: 'fatal: early EOF canary-secret',
      code: 'git_fetch_transport_failed',
      truncated: false,
    },
    {
      stderr: `${'canary-secret'.repeat(500)}The requested URL returned error: 403`,
      code: 'git_fetch_failed',
      truncated: true,
    },
    {
      stderr: 'fatal: access https://example.invalid/403?status=401 canary-secret',
      code: 'git_fetch_failed',
      truncated: false,
    },
  ])('retains safe terminal facts for $code (truncated=$truncated)', async ({
    stderr,
    code,
    truncated,
  }) => {
    const remote = createBareGitRemote({ 'README.md': '# failed\n' });
    const root = mkdtempSync(join(tmpdir(), 'openkit-fetch-observation-'));
    const sessionDir = join(root, 'session');
    const workspaceRoot = join(root, 'workspace');
    mkdirSync(sessionDir);
    const failure = await withScriptedGit(
      root,
      join(root, 'git.log'),
      {
        shaFetch: 'unrecognized',
        advertisedStderr: stderr,
      },
      () =>
        materializeWorkspaceGitInputs(
          [
            createWorkspaceGitInput(
              join(workspaceRoot, 'worktrees', 'main'),
              remote.commit,
              remote.path
            ),
          ],
          workspaceRoot,
          sessionDir
        )
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      explanation: {
        code,
        subprocess: 'exit',
        httpStatus: code === 'git_fetch_http_refused' ? 403 : null,
        evidence: { availability: 'partial', outputTruncated: truncated },
      },
    });
    expect(JSON.stringify(failure)).not.toContain('canary-secret');
  });

  it('retains a real fetch spawn failure without stderr or fallback', async () => {
    const remote = createBareGitRemote({ 'README.md': '# spawn failure\n' });
    const root = mkdtempSync(join(tmpdir(), 'openkit-fetch-spawn-'));
    const sessionDir = join(root, 'session');
    const workspaceRoot = join(root, 'workspace');
    mkdirSync(sessionDir);
    const oldPath = process.env.PATH;
    try {
      await withScriptedGit(
        root,
        join(root, 'git.log'),
        {
          shaFetch: 'unrecognized',
          removeAfterRemote: true,
        },
        async () => {
          process.env.PATH = `${join(root, 'bin')}${delimiter}${dirname(process.execPath)}`;
          await expect(
            materializeWorkspaceGitInputs(
              [
                createWorkspaceGitInput(
                  join(workspaceRoot, 'worktrees', 'main'),
                  remote.commit,
                  remote.path
                ),
              ],
              workspaceRoot,
              sessionDir
            )
          ).rejects.toMatchObject({
            explanation: {
              code: 'git_fetch_transport_failed',
              subprocess: 'spawn',
              httpStatus: null,
            },
          });
        }
      );
    } finally {
      process.env.PATH = oldPath;
    }
  });

  it('checks out after a certificate failure when the advertised fallback succeeds', async () => {
    const remote = createBareGitRemote({ 'README.md': '# TLS then advertised\n' });
    const root = mkdtempSync(join(tmpdir(), 'openkit-workspace-tls-fallback-'));
    const workspaceRoot = join(root, 'workspace');
    const sessionDir = join(root, 'session');
    const target = join(workspaceRoot, 'worktrees', 'main');
    mkdirSync(sessionDir);

    await withScriptedGit(root, join(root, 'git-invocations.log'), { shaFetch: 'tls' }, () =>
      materializeWorkspaceGitInputs(
        [createWorkspaceGitInput(target, remote.commit, remote.path)],
        workspaceRoot,
        sessionDir
      )
    );

    expect(gitText(target, ['rev-parse', 'HEAD'])).toBe(remote.commit);
    expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('# TLS then advertised\n');
  });

  it('classifies a terminal certificate failure and keeps the partial slot', async () => {
    const remote = createBareGitRemote({ 'README.md': '# TLS failure\n' });
    const root = mkdtempSync(join(tmpdir(), 'openkit-workspace-tls-terminal-'));
    const workspaceRoot = join(root, 'workspace');
    const sessionDir = join(root, 'session');
    const target = join(workspaceRoot, 'worktrees', 'main');
    mkdirSync(sessionDir);

    await expect(
      withScriptedGit(
        root,
        join(root, 'git-invocations.log'),
        { advertisedFetch: 'tls', shaFetch: 'tls' },
        () =>
          materializeWorkspaceGitInputs(
            [createWorkspaceGitInput(target, remote.commit, remote.path)],
            workspaceRoot,
            sessionDir
          )
      )
    ).rejects.toThrow('Remote Git commit fetch TLS failed.');

    expect(existsSync(join(target, '.git'))).toBe(true);
    expect(existsSync(join(target, 'README.md'))).toBe(false);
  });

  it('classifies a terminal transport failure after the advertised fallback', async () => {
    const remote = createBareGitRemote({ 'README.md': '# Transport failure\n' });
    const root = mkdtempSync(join(tmpdir(), 'openkit-workspace-transport-terminal-'));
    const workspaceRoot = join(root, 'workspace');
    const sessionDir = join(root, 'session');
    const target = join(workspaceRoot, 'worktrees', 'main');
    mkdirSync(sessionDir);

    await expect(
      withScriptedGit(
        root,
        join(root, 'git-invocations.log'),
        { advertisedFetch: 'early-eof', shaFetch: 'unrecognized' },
        () =>
          materializeWorkspaceGitInputs(
            [createWorkspaceGitInput(target, remote.commit, remote.path)],
            workspaceRoot,
            sessionDir
          )
      )
    ).rejects.toThrow('Remote Git commit fetch transport failed.');

    expect(existsSync(join(target, '.git'))).toBe(true);
    expect(existsSync(join(target, 'README.md'))).toBe(false);
  });

  it.each([
    {
      advertisedFetch: 'gnutls' as const,
      message: 'Remote Git commit fetch TLS failed.',
    },
    {
      advertisedFetch: 'gnutls-verify' as const,
      message: 'Remote Git commit fetch TLS failed.',
    },
    {
      advertisedFetch: 'proxy' as const,
      message: 'Remote Git commit fetch transport failed.',
    },
    {
      advertisedFetch: 'proxy-resolve' as const,
      message: 'Remote Git commit fetch transport failed.',
    },
  ])('classifies a terminal $advertisedFetch fallback without collapsing it', async ({
    advertisedFetch,
    message,
  }) => {
    const remote = createBareGitRemote({ 'README.md': '# Classified fallback\n' });
    const root = mkdtempSync(join(tmpdir(), `openkit-workspace-${advertisedFetch}-`));
    const workspaceRoot = join(root, 'workspace');
    const sessionDir = join(root, 'session');
    const target = join(workspaceRoot, 'worktrees', 'main');
    mkdirSync(sessionDir);

    await expect(
      withScriptedGit(
        root,
        join(root, 'git-invocations.log'),
        { advertisedFetch, shaFetch: 'unrecognized' },
        () =>
          materializeWorkspaceGitInputs(
            [createWorkspaceGitInput(target, remote.commit, remote.path)],
            workspaceRoot,
            sessionDir
          )
      )
    ).rejects.toThrow(message);

    expect(existsSync(join(target, '.git'))).toBe(true);
    expect(existsSync(join(target, 'README.md'))).toBe(false);
  });

  it('refuses a commit the configured remote does not serve and keeps the partial slot', async () => {
    const remote = createBareGitRemote({ 'README.md': '# Other commit\n' });
    const root = mkdtempSync(join(tmpdir(), 'openkit-workspace-missing-commit-'));
    const workspaceRoot = join(root, 'workspace');
    const sessionDir = join(root, 'session');
    const target = join(workspaceRoot, 'worktrees', 'main');
    mkdirSync(sessionDir);

    await expect(
      materializeWorkspaceGitInputs(
        [createWorkspaceGitInput(target, 'a'.repeat(40), remote.path)],
        workspaceRoot,
        sessionDir
      )
    ).rejects.toThrow('Remote Git commit is not available from the configured remote.');

    expect(existsSync(join(target, '.git'))).toBe(true);
    expect(existsSync(join(target, 'README.md'))).toBe(false);
  });
});

function createTagOnlyGitRemote(): { commit: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'openkit-workspace-git-tag-remote-'));
  const sourceDir = join(root, 'source');
  const remotePath = join(root, 'remote.git');
  mkdirSync(sourceDir);
  git(sourceDir, ['init']);
  git(sourceDir, ['config', 'user.email', 'worker@example.com']);
  git(sourceDir, ['config', 'user.name', 'Worker']);
  writeFixtureFile(sourceDir, 'README.md', '# Branch\n');
  git(sourceDir, ['add', '.']);
  git(sourceDir, ['commit', '-m', 'branch']);
  writeFixtureFile(sourceDir, 'README.md', '# Tag only\n');
  git(sourceDir, ['add', '.']);
  git(sourceDir, ['commit', '-m', 'tag']);
  const commit = gitText(sourceDir, ['rev-parse', 'HEAD']);
  git(sourceDir, ['tag', 'v1', commit]);
  git(sourceDir, ['reset', '--hard', 'HEAD~1']);
  execFileSync('git', ['clone', '--bare', sourceDir, remotePath], { stdio: 'ignore' });
  return { commit, path: remotePath };
}

async function withScriptedGit(
  root: string,
  logPath: string,
  behavior: {
    advertisedFetch?: 'early-eof' | 'gnutls' | 'gnutls-verify' | 'proxy' | 'proxy-resolve' | 'tls';
    advertisedStderr?: string;
    removeAfterRemote?: boolean;
    catFile?: 'fail';
    shaFetch: 'hang-after-refusal' | 'tls' | 'unrecognized' | 'missing-ref';
  },
  body: () => Promise<void>
): Promise<void> {
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(
    join(bin, 'git'),
    `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { appendFileSync, unlinkSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + '\\n');
const shaFetch = args.includes('fetch') && args.some((arg) => /^[0-9a-f]{40}$/.test(arg));
const catFile = args.includes('cat-file');
if (shaFetch && ${JSON.stringify(behavior.shaFetch)} === 'hang-after-refusal') {
  process.stderr.write('fatal: remote error: upload-pack: not our ref ' + args.at(-1) + '\\n');
  setInterval(() => {}, 1000);
  appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(['fixture.fetch-hanging']) + '\\n');
  return;
}
if (shaFetch && ${JSON.stringify(behavior.shaFetch)} === 'unrecognized') {
  process.stderr.write('fatal: early EOF\\n');
  process.exit(128);
}
if (shaFetch && ${JSON.stringify(behavior.shaFetch)} === 'tls') {
  process.stderr.write('fatal: SSL certificate problem: unable to get local issuer certificate\\n');
  process.exit(128);
}
const advertisedFailure = ${JSON.stringify(
      behavior.advertisedStderr ??
        (behavior.advertisedFetch === 'tls'
          ? 'fatal: SSL certificate problem: self-signed certificate in certificate chain\n'
          : behavior.advertisedFetch === 'gnutls'
            ? "fatal: unable to access 'https://127.0.0.1:9/repo.git/': server verification failed: certificate signer not trusted. (CAfile: /etc/ssl/certs/ca-certificates.crt CRLfile: none)\n"
            : behavior.advertisedFetch === 'gnutls-verify'
              ? 'fatal: server certificate verification failed\n'
              : behavior.advertisedFetch === 'proxy'
                ? "fatal: unable to access 'https://example.invalid/repo.git/': CONNECT tunnel failed, response 407\n"
                : behavior.advertisedFetch === 'proxy-resolve'
                  ? "fatal: unable to access 'https://example.invalid/repo.git/': Could not resolve proxy: example.invalid\n"
                  : behavior.advertisedFetch === 'early-eof'
                    ? 'fatal: early EOF\n'
                    : '')
    )};
if (advertisedFailure && args.includes('fetch') && args.some((arg) => String(arg).includes('refs/'))) {
  process.stderr.write(advertisedFailure);
  process.exit(128);
}
if (catFile && ${JSON.stringify(behavior.catFile ?? '')} === 'fail') {
  process.stderr.write('fatal: unable to access object\\n');
  process.exit(2);
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
if (${JSON.stringify(behavior.removeAfterRemote ?? false)} && args.includes('remote') && args.includes('add')) unlinkSync(process.argv[1]);
process.exit(result.status === null ? 1 : result.status);
`
  );
  chmodSync(join(bin, 'git'), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previousPath ?? ''}`;
  try {
    await body();
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
  }
}

async function withShaRefusingGit(
  root: string,
  failAdvertisedFetch: boolean,
  body: () => Promise<void>
): Promise<void> {
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const advertisedRefusal = failAdvertisedFetch
    ? `if (args.includes('fetch') && args.some((arg) => String(arg).includes('refs/'))) {
  process.stderr.write('fatal: unable to access origin\\n');
  process.exit(128);
}
`
    : '';
  writeFileSync(
    join(bin, 'git'),
    `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('fetch') && args.some((arg) => /^[0-9a-f]{40}$/.test(arg))) {
  process.stderr.write('fatal: remote error: upload-pack: not our ref ' + args.at(-1) + '\\n');
  process.exit(128);
}
${advertisedRefusal}const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
`
  );
  chmodSync(join(bin, 'git'), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previousPath ?? ''}`;
  try {
    await body();
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
  }
}

function createBareGitRemote(files: Readonly<Record<string, string | Buffer>>): {
  commit: string;
  path: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'openkit-workspace-git-remote-'));
  const sourceDir = join(root, 'source');
  const remotePath = join(root, 'remote.git');
  mkdirSync(sourceDir);
  git(sourceDir, ['init']);
  git(sourceDir, ['config', 'user.email', 'worker@example.com']);
  git(sourceDir, ['config', 'user.name', 'Worker']);
  for (const [path, content] of Object.entries(files)) {
    writeFixtureFile(sourceDir, path, content);
  }
  git(sourceDir, ['add', '.']);
  git(sourceDir, ['commit', '-m', 'initial']);
  const commit = gitText(sourceDir, ['rev-parse', 'HEAD']);
  execFileSync('git', ['clone', '--bare', sourceDir, remotePath], { stdio: 'ignore' });
  return { commit, path: remotePath };
}

function createWorkspaceGitInput(target: string, commit: string, url: string): WorkspaceGitInput {
  return {
    access: 'read-write',
    id: 'repo',
    source: {
      catalogEntryDigest: `sha256:${'1'.repeat(64)}`,
      commit,
      kind: 'git',
      sensitivity: 'internal',
      sourceId: 'repo',
      sourceRef: 'main-repo',
      url,
    },
    target,
  };
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function gitText(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function writeFixtureFile(root: string, path: string, content: string | Buffer): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
