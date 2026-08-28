import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const governanceScript = join(repoRoot, 'scripts/validate-test-governance.mjs');

/**
 * Imports the future test-governance module after proving the script exists.
 *
 * @returns {Promise<{
 *   runTestSuite: (options: {
 *     allowedSkipDeclarations?: { file: string; name: string }[];
 *     command: string[];
 *     discoveredTestFiles?: string[];
 *   }) => string[];
 *   validateTestGovernance: (root: string) => string[];
 * }>} Governance exports.
 */
async function loadGovernance() {
  assert.equal(
    existsSync(governanceScript),
    true,
    'scripts/validate-test-governance.mjs is missing'
  );
  const module = await import(pathToFileURL(governanceScript).href);
  assert.equal(
    typeof module.validateTestGovernance,
    'function',
    'scripts/validate-test-governance.mjs does not export validateTestGovernance'
  );
  assert.equal(
    typeof module.runTestSuite,
    'function',
    'scripts/validate-test-governance.mjs does not export runTestSuite'
  );
  return module;
}

/**
 * Writes one isolated fixture repository for governance checks.
 *
 * @param {Record<string, string>} files Repository-relative path to file body.
 * @returns {string} Temporary root.
 */
function writeFixtureRepo(files) {
  const root = mkdtempSync(join(tmpdir(), 'openkit-test-governance-'));
  for (const [relativePath, body] of Object.entries(files)) {
    const path = join(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  return root;
}

test('validateTestGovernance rejects a skip reachable from catch', async () => {
  const { validateTestGovernance } = await loadGovernance();
  const root = writeFixtureRepo({
    'tests/catch-skip.test.mjs': `import test from 'node:test';
test('hidden skip', (t) => {
  try {
    throw new Error('missing capability');
  } catch {
    t.skip('unavailable');
  }
});
`,
  });

  try {
    const errors = validateTestGovernance(root);
    assert.ok(errors.length > 0, 'catch-skip fixture was accepted');
    assert.match(errors.join('\n'), /skip|catch/i);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('validateTestGovernance allows pre-run platform predicates and declared env opt-in', async () => {
  const { validateTestGovernance } = await loadGovernance();
  const root = writeFixtureRepo({
    'tests/allowed-skip.test.mjs': `import test from 'node:test';
test.skipIf(process.platform === 'win32')('platform predicate', () => {});
test.skipIf(process.env.OPENKIT_E2E_REAL_CODEX !== '1')('declared opt-in', () => {});
`,
  });

  try {
    assert.deepEqual(validateTestGovernance(root), []);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('validateTestGovernance accepts an imperative skip guarded by a pre-run OPENKIT opt-in', async () => {
  const { validateTestGovernance } = await loadGovernance();
  const root = writeFixtureRepo({
    'tests/imperative-opt-in.test.mjs': `import test from 'node:test';
test('real gate', (t) => {
  if (process.env.OPENKIT_REAL_GATE !== '1') t.skip('opt-in disabled');
});
`,
  });

  try {
    assert.deepEqual(validateTestGovernance(root), []);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('validateTestGovernance rejects a skip nested under an unadmitted control-flow condition', async () => {
  const { validateTestGovernance } = await loadGovernance();
  const root = writeFixtureRepo({
    'tests/nested-skip.test.mjs': `import test from 'node:test';
test('nested skip', (t) => {
  const capabilityFailed = true;
  if (capabilityFailed) {
    if (process.env.OPENKIT_REAL_GATE !== '1') t.skip('unavailable');
  }
});
`,
  });

  try {
    const errors = validateTestGovernance(root);
    assert.ok(errors.length > 0, 'nested runtime condition around an OPENKIT skip was accepted');
    assert.match(errors.join('\n'), /skip|pre-run|runtime/i);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('validateTestGovernance rejects skipIf that is not wholly a pre-run predicate', async () => {
  const { validateTestGovernance } = await loadGovernance();
  const root = writeFixtureRepo({
    'tests/mixed-skip.test.mjs': `import test from 'node:test';
const capabilityFailed = true;
test.skipIf(capabilityFailed || process.env.OPENKIT_OPT_IN !== "1")('mixed predicate', () => {});
`,
  });

  try {
    const errors = validateTestGovernance(root);
    assert.ok(errors.length > 0, 'mixed skipIf predicate was accepted');
    assert.match(errors.join('\n'), /skipIf|pre-run/i);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('validateTestGovernance rejects skipIf(true) as an undeclared opt-in', async () => {
  const { validateTestGovernance } = await loadGovernance();
  const root = writeFixtureRepo({
    'tests/literal-skip.test.mjs': `import test from 'node:test';
test.skipIf(true)('literal skip', () => {});
`,
  });

  try {
    const errors = validateTestGovernance(root);
    assert.ok(errors.length > 0, 'skipIf(true) was accepted as a declared opt-in');
    assert.match(errors.join('\n'), /skipIf|pre-run|opt-in/i);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('validateTestGovernance rejects ordinary docker invocation and allows Dockerfile reads', async () => {
  const { validateTestGovernance } = await loadGovernance();
  const invocation = (runtime) => `import { spawnSync } from 'node:child_process';
import test from 'node:test';
test('runs ${runtime}', () => {
  spawnSync('${runtime}', ['info']);
});
`;
  const table = [
    { allowed: false, id: 'docker', runtime: 'docker', source: invocation('docker') },
    { allowed: false, id: 'podman', runtime: 'podman', source: invocation('podman') },
    { allowed: false, id: 'nerdctl', runtime: 'nerdctl', source: invocation('nerdctl') },
    {
      allowed: true,
      id: 'dockerfile-text',
      source: `import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
test('reads Dockerfile text', () => {
  assert.match(readFileSync('containers/test-env/Dockerfile', 'utf8'), /^FROM /m);
});
`,
    },
    {
      allowed: true,
      id: 'container-subject',
      files: {
        'package.json': `${JSON.stringify({
          name: 'fixture',
          scripts: {
            'test:container-subject':
              'bash scripts/test-env.sh host node --test tests/container-subject.test.mjs',
          },
        })}\n`,
      },
      runtime: 'docker',
      source: `// openkit-test-container-subject
${invocation('docker')}`,
    },
  ];
  const roots = [];

  try {
    assert.deepEqual(
      Object.fromEntries(
        table.map((row) => {
          const root = writeFixtureRepo({
            [`tests/${row.id}.test.mjs`]: row.source,
            ...row.files,
          });
          roots.push(root);
          const errors = validateTestGovernance(root);
          if (row.allowed) return [row.id, errors];
          const text = errors.join('\n');
          return [
            row.id,
            {
              namesContainerFamily: /container runtime/i.test(text),
              namesRuntime: new RegExp(`\\b${row.runtime}\\b`, 'i').test(text),
            },
          ];
        })
      ),
      Object.fromEntries(
        table.map((row) => [
          row.id,
          row.allowed ? [] : { namesContainerFamily: true, namesRuntime: true },
        ])
      )
    );
  } finally {
    for (const root of roots) rmSync(root, { force: true, recursive: true });
  }
});

test('validateTestGovernance rejects literal container runtime basename and env-prefixed path', async () => {
  const { validateTestGovernance } = await loadGovernance();
  const table = [
    {
      id: 'execFileSync-basename',
      runtime: 'docker',
      source: `import { execFileSync } from 'node:child_process';
import test from 'node:test';
test('runs docker', () => {
  execFileSync('/usr/bin/docker', ['info']);
});
`,
    },
    {
      id: 'execSync-env-prefix',
      runtime: 'docker',
      source: `import { execSync } from 'node:child_process';
import test from 'node:test';
test('runs docker', () => {
  execSync('DOCKER_HOST=unix:///tmp/docker.sock /usr/bin/docker info');
});
`,
    },
  ];
  const roots = [];

  try {
    assert.deepEqual(
      Object.fromEntries(
        table.map((row) => {
          const root = writeFixtureRepo({ [`tests/${row.id}.test.mjs`]: row.source });
          roots.push(root);
          const text = validateTestGovernance(root).join('\n');
          return [
            row.id,
            {
              namesContainerFamily: /container runtime/i.test(text),
              namesRuntime: new RegExp(`\\b${row.runtime}\\b`, 'i').test(text),
            },
          ];
        })
      ),
      Object.fromEntries(
        table.map((row) => [row.id, { namesContainerFamily: true, namesRuntime: true }])
      )
    );
  } finally {
    for (const root of roots) rmSync(root, { force: true, recursive: true });
  }
});

test('validateTestGovernance requires a declaration for enumerated platform interfaces', async () => {
  const { validateTestGovernance } = await loadGovernance();
  const table = [
    {
      family: 'process.platform',
      finding: /process\.platform/u,
      source: `import test from 'node:test';
test('uses process.platform', () => {
  if (process.platform === 'darwin') {
    throw new Error('implicit');
  }
});
`,
    },
    {
      family: 'node:os',
      finding: /node:os|\bos\.(?:arch|platform)\b/u,
      source: `import { arch, platform } from 'node:os';
import test from 'node:test';
test('uses os accessors', () => {
  platform();
  arch();
});
`,
    },
    {
      family: 'process-group',
      finding: /process\.kill|detached|process-group|signal/u,
      source: `import { spawn } from 'node:child_process';
import test from 'node:test';
test('uses process-group operations', () => {
  process.kill(process.pid, 0);
  spawn('true', { detached: true });
});
`,
    },
    {
      family: 'proc-cgroup',
      finding: /\/proc|cgroup/u,
      source: `import { readFileSync } from 'node:fs';
import test from 'node:test';
test('reads proc and cgroup paths', () => {
  readFileSync('/proc/self/cgroup');
  readFileSync('/sys/fs/cgroup');
});
`,
    },
    {
      family: 'path-links',
      finding: /realpath|readlink|symlink|link-resolution|case-sensitiv/u,
      source: `import { readlinkSync, realpathSync, symlinkSync } from 'node:fs';
import test from 'node:test';
test('resolves path links', () => {
  symlinkSync('target', 'link');
  realpathSync('link');
  readlinkSync('link');
});
`,
    },
  ];
  const processGroup = table.find((row) => row.family === 'process-group');
  const roots = [];

  try {
    const observed = {};
    const expected = {};
    for (const row of table) {
      const undeclared = writeFixtureRepo({
        [`tests/${row.family}-undeclared.test.mjs`]: row.source,
      });
      const posix = writeFixtureRepo({
        [`tests/${row.family}-posix.test.mjs`]: `// openkit-test-platform: posix
${row.source}`,
      });
      roots.push(undeclared, posix);
      observed[`${row.family}:undeclared`] = row.finding.test(
        validateTestGovernance(undeclared).join('\n')
      );
      observed[`${row.family}:posix`] = validateTestGovernance(posix);
      expected[`${row.family}:undeclared`] = true;
      expected[`${row.family}:posix`] = [];
    }
    const divergence = writeFixtureRepo({
      'tests/platform-divergence.test.mjs': `// openkit-test-platform-divergence
${processGroup.source}`,
    });
    const predicates = writeFixtureRepo({
      'tests/platform-predicates.test.mjs': `import test from 'node:test';
test.skipIf(process.platform === 'win32')('declared skipIf platform', () => {});
test.runIf(process.platform === 'linux')('declared runIf platform', () => {});
`,
    });
    roots.push(divergence, predicates);
    observed.divergence = validateTestGovernance(divergence);
    observed.predicates = validateTestGovernance(predicates);
    expected.divergence = [];
    expected.predicates = [];
    assert.deepEqual(observed, expected);
  } finally {
    for (const root of roots) rmSync(root, { force: true, recursive: true });
  }
});

test('validateTestGovernance does not let one platform-guarded test exempt an unguarded process.kill', async () => {
  const { validateTestGovernance } = await loadGovernance();
  const root = writeFixtureRepo({
    'tests/mixed-platform.test.mjs': `import test from 'node:test';
test.skipIf(process.platform === 'win32')('guarded', () => {});
test('unguarded kill', () => {
  process.kill(process.pid, 0);
});
`,
  });

  try {
    const text = validateTestGovernance(root).join('\n');
    assert.match(text, /process\.kill|process-group|signal/u);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('validateTestGovernance accepts container-subject pragma only under host placement', async () => {
  const { validateTestGovernance } = await loadGovernance();
  const source = `// openkit-test-container-subject
import { spawnSync } from 'node:child_process';
import test from 'node:test';
test('runs docker', () => {
  spawnSync('docker', ['info']);
});
`;
  const roots = [];

  try {
    const observed = Object.fromEntries(
      ['absent', 'any', 'host'].map((placement) => {
        const files = { 'tests/container-subject.test.mjs': source };
        if (placement !== 'absent') {
          files['package.json'] = `${JSON.stringify({
            name: 'fixture',
            scripts: {
              'test:container-subject': `bash scripts/test-env.sh ${placement} node --test tests/container-subject.test.mjs`,
            },
          })}\n`;
        }
        const root = writeFixtureRepo(files);
        roots.push(root);
        const errors = validateTestGovernance(root);
        if (placement === 'host') return [placement, errors];
        const text = errors.join('\n');
        return [
          placement,
          {
            namesContainerFamily: /container runtime/i.test(text),
            namesRuntime: /\bdocker\b/i.test(text),
          },
        ];
      })
    );
    assert.deepEqual(observed, {
      absent: { namesContainerFamily: true, namesRuntime: true },
      any: { namesContainerFamily: true, namesRuntime: true },
      host: [],
    });
  } finally {
    for (const root of roots) rmSync(root, { force: true, recursive: true });
  }
});

test('validateTestGovernance rejects unmapped execSync docker info despite container-subject pragma', async () => {
  const { validateTestGovernance } = await loadGovernance();
  const root = writeFixtureRepo({
    'tests/subject.test.mjs': `// openkit-test-container-subject
import { execSync } from 'node:child_process';
import test from 'node:test';
test('runs docker', () => {
  execSync('docker info');
});
`,
  });

  try {
    const text = validateTestGovernance(root).join('\n');
    assert.match(text, /container runtime/i);
    assert.match(text, /\bdocker\b/i);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('validateTestGovernance does not treat an echoed path as host placement', async () => {
  const { validateTestGovernance } = await loadGovernance();
  const root = writeFixtureRepo({
    'package.json': `${JSON.stringify({
      name: 'fixture',
      scripts: {
        'test:subject': 'echo tests/subject.test.mjs && bash scripts/test-env.sh host true',
      },
    })}\n`,
    'tests/subject.test.mjs': `// openkit-test-container-subject
import { spawnSync } from 'node:child_process';
import test from 'node:test';
test('runs docker', () => {
  spawnSync('docker', ['info']);
});
`,
  });

  try {
    const text = validateTestGovernance(root).join('\n');
    assert.match(text, /container runtime/i);
    assert.match(text, /\bdocker\b/i);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('validateTestGovernance does not host-map a test path echoed after the host command', async () => {
  const { validateTestGovernance } = await loadGovernance();
  const root = writeFixtureRepo({
    'package.json': `${JSON.stringify({
      name: 'fixture',
      scripts: {
        'test:subject': 'bash scripts/test-env.sh host true && echo tests/subject.test.mjs',
      },
    })}\n`,
    'tests/subject.test.mjs': `// openkit-test-container-subject
import { spawnSync } from 'node:child_process';
import test from 'node:test';
test('runs docker', () => {
  spawnSync('docker', ['info']);
});
`,
  });

  try {
    const text = validateTestGovernance(root).join('\n');
    assert.match(text, /container runtime/i);
    assert.match(text, /\bdocker\b/i);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('validateTestGovernance CLI exits nonzero on findings', async () => {
  await loadGovernance();
  const root = writeFixtureRepo({
    'tests/catch-skip.test.mjs': `import test from 'node:test';
test('hidden skip', (t) => {
  try {
    throw new Error('missing');
  } catch {
    t.skip();
  }
});
`,
  });

  try {
    const result = spawnSync(process.execPath, [governanceScript, root], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.notEqual(result.status, null);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('runTestSuite authorizes skips only through file-bound declarations', async () => {
  const { runTestSuite } = await loadGovernance();
  const reporter = writeFixtureRepo({
    'tests/declared.test.mjs': `import test from 'node:test';
test.skipIf(process.env.OPENKIT_REAL_GATE !== '1')('leaf', () => {});
`,
    'report-flat.mjs': `process.stdout.write('ok 1 - undeclared # SKIP\\n');
`,
    'report-hierarchy.mjs': `process.stdout.write('ok 1 - tests/declared.test.mjs > declared suite > leaf # SKIP\\n');
`,
  });

  try {
    const deniedFileLess = runTestSuite({
      allowedSkipDeclarations: [],
      command: [process.execPath, join(reporter, 'report-flat.mjs')],
      discoveredTestFiles: [],
    });
    assert.ok(
      deniedFileLess.length > 0,
      'file-less TAP skip was accepted without a file-bound declaration'
    );
    const accepted = runTestSuite({
      allowedSkipDeclarations: [{ file: 'tests/declared.test.mjs', name: 'leaf' }],
      command: [process.execPath, join(reporter, 'report-hierarchy.mjs')],
      discoveredTestFiles: ['tests/declared.test.mjs'],
    });
    assert.deepEqual(accepted, []);
  } finally {
    rmSync(reporter, { force: true, recursive: true });
  }
});

test('runTestSuite does not authorize a skip title declared by a different file', async () => {
  await loadGovernance();
  const root = writeFixtureRepo({
    'tests/declared.test.mjs': `import test from 'node:test';
test.skipIf(process.platform === 'win32')('shared title', () => {});
`,
    'report.mjs': `process.stdout.write('ok 1 - shared title # SKIP\\n');
`,
  });

  try {
    const result = spawnSync(
      process.execPath,
      [governanceScript, '--run', '--', process.execPath, join(root, 'report.mjs')],
      { cwd: root, encoding: 'utf8' }
    );
    assert.notEqual(result.status, 0, 'duplicate skip title was authorized by another file');
    assert.notEqual(result.status, null);
    assert.match(result.stderr, /skip|undeclared|shared title/i);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('runTestSuite fails closed when a reporter path suffix-matches two declaring corpus files', async () => {
  await loadGovernance();
  const declared = `import test from 'node:test';
test.skipIf(process.platform === 'win32')('leaf', () => {});
`;
  const undeclared = `import test from 'node:test';
test('other', () => {});
`;
  const root = writeFixtureRepo({
    'pkg-a/src/shared.test.ts': declared,
    'pkg-b/src/shared.test.ts': undeclared,
    'report.mjs': `process.stdout.write('ok 1 - src/shared.test.ts > declared suite > leaf # SKIP\\n');
`,
  });

  try {
    const result = spawnSync(
      process.execPath,
      [governanceScript, '--run', '--', process.execPath, join(root, 'report.mjs')],
      { cwd: root, encoding: 'utf8' }
    );
    assert.notEqual(
      result.status,
      0,
      'ambiguous src/shared.test.ts suffix authorized a skip declared in only one file'
    );
    assert.notEqual(result.status, null);
    assert.match(result.stderr, /skip|undeclared|leaf/i);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('runTestSuite rejects Vitest skipped-test summary output', async () => {
  const { runTestSuite } = await loadGovernance();
  const reporter = writeFixtureRepo({
    'report.mjs': `process.stdout.write('\\n RUN  v4.1.4 /fixture\\n\\n\\n Test Files  1 skipped (1)\\n      Tests  1 skipped (1)\\n');
`,
  });

  try {
    const errors = runTestSuite({
      command: [process.execPath, join(reporter, 'report.mjs')],
    });
    assert.ok(errors.length > 0, 'Vitest skipped-test summary was accepted');
    assert.match(errors.join('\n'), /skip/i);
  } finally {
    rmSync(reporter, { force: true, recursive: true });
  }
});

test('runTestSuite rejects Vitest skipped-test summary even when a file-bound declaration exists', async () => {
  const { runTestSuite } = await loadGovernance();
  const reporter = writeFixtureRepo({
    'report.mjs': `process.stdout.write('\\n RUN  v4.1.4 /fixture\\n\\n\\n Test Files  1 skipped (1)\\n      Tests  1 skipped (1)\\n');
`,
  });

  try {
    const errors = runTestSuite({
      allowedSkipDeclarations: [{ file: 'src/file.test.ts', name: 'declared' }],
      command: [process.execPath, join(reporter, 'report.mjs')],
      discoveredTestFiles: ['src/file.test.ts'],
    });
    assert.ok(
      errors.length > 0,
      'Vitest skipped-test summary was accepted because a file-bound declaration existed'
    );
    assert.match(errors.join('\n'), /skip/i);
  } finally {
    rmSync(reporter, { force: true, recursive: true });
  }
});

test('runTestSuite retains full repository-scale reporter output', async () => {
  const { runTestSuite } = await loadGovernance();
  const reporter = writeFixtureRepo({
    'report.mjs': `process.stdout.write('ok 1 - ordinary test\\n'.repeat(100_000));
`,
  });

  try {
    const errors = runTestSuite({
      command: [process.execPath, join(reporter, 'report.mjs')],
    });
    assert.deepEqual(errors, []);
  } finally {
    rmSync(reporter, { force: true, recursive: true });
  }
});

test('runTestSuite attributes Turbo tap-flat skip lines by hierarchy component', async () => {
  const { runTestSuite } = await loadGovernance();
  const reporter = writeFixtureRepo({
    'report.mjs': `process.stdout.write('@openkit/nanocore:test: ok 1 - src/file.test.ts > declared suite > leaf # SKIP\\n');
`,
  });

  try {
    const discoveredTestFiles = ['src/file.test.ts'];
    const observed = Object.fromEntries(
      [
        ['empty', []],
        ['unrelated', [{ file: 'src/file.test.ts', name: 'undeclared' }]],
        ['leaf', [{ file: 'src/file.test.ts', name: 'leaf' }]],
        ['suite', [{ file: 'src/file.test.ts', name: 'declared suite' }]],
      ].map(([id, allowedSkipDeclarations]) => {
        const errors = runTestSuite({
          allowedSkipDeclarations,
          command: [process.execPath, join(reporter, 'report.mjs')],
          discoveredTestFiles,
        });
        return [id, errors.length === 0];
      })
    );
    assert.deepEqual(observed, {
      empty: false,
      unrelated: false,
      leaf: true,
      suite: true,
    });
  } finally {
    rmSync(reporter, { force: true, recursive: true });
  }
});
