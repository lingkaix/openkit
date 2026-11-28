#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
/** Offline pre-tag admission over retained, independently collected publication observations. */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  directStableGrant,
  isDirectStableTag,
  parseVersionTag,
  readReleaseAssessment,
  validateCandidateQualification,
} from './release-preflight.mjs';
import { canonical, sha } from './release-safety.mjs';

export const registryJob = 'Prerelease registry admission';
export const candidateJobs = [
  'L0-L2 static, unit, contract',
  'L3 NanoCore e2e',
  'L4 Web e2e',
  'L5 smoke',
  'L5 app-image stopped-server recovery',
  'NanoHost installer fixed-path gate (ubuntu-24.04)',
  'NanoHost installer fixed-path gate (ubuntu-26.04)',
  'Smoke worker-common (linux/amd64)',
  'Smoke worker-common (linux/arm64)',
  'Smoke worker-runtimes (linux/amd64)',
  'Smoke worker-runtimes (linux/arm64)',
];
export const directCandidateJobs = [
  'Direct stable publication proof',
  registryJob,
  'Release preflight',
  'Build NanoHost natively on amd64',
  'Build NanoHost natively on arm64',
  'Package portable release assets',
  'Qualify NanoHost on amd64',
  'Qualify NanoHost on arm64',
  'Read app candidate',
  'Smoke App native (linux/amd64)',
  'Smoke App native (linux/arm64)',
];
export const publicationJobs = [
  'Publish app image',
  'Publish worker-common image',
  'Publish worker-runtimes image',
  'Publish GitHub Release',
  'Verify published release',
];
const commit = /^[a-f0-9]{40}$/;
const hash = /^[a-f0-9]{64}$/;
const legacyFirstTag = 'v0.1.0-rc.6';
const trainFirstTag = 'v0.1.1-rc.1';
const prereleaseTag = /^v0\.1\.(0|[1-9]\d*)-rc\.([1-9]\d*)$/u;

/** The approved first tag selects the former RC cycle or its 0.1.x successor. */
export function grantCoversPrerelease(tag, firstTag) {
  if (firstTag !== legacyFirstTag && firstTag !== trainFirstTag) return false;
  const match = typeof tag === 'string' ? prereleaseTag.exec(tag) : null;
  if (!match) return false;
  const [, patch, candidate] = match;
  if (firstTag === trainFirstTag) return patch !== '0';
  const releaseCandidate = Number(candidate);
  const firstCandidate = Number(prereleaseTag.exec(firstTag)[2]);
  return (
    patch === '0' && Number.isSafeInteger(releaseCandidate) && releaseCandidate >= firstCandidate
  );
}

/** Fail closed on a missing publication predicate. */
function requireFact(holds, name) {
  if (!holds) throw Error(`Release Management: publication refused: ${name}`);
}
const buildScript = 'NanoHost build script is outside the supported subset';
const pathSymlink = 'compiled path symlink is outside the supported subset';
const pathComponent = 'compiled path component is outside the supported subset';
const compilerObservation = 'compiler-observed publication input unavailable';
/** NUL-separated Git tree rows preserve every exact path byte sequence. */
function treeRows(output) {
  return output.split('\0').filter(Boolean);
}

/** One exact Git tree row, or null when NUL output has no row for that path. */
function treeEntry(output, file) {
  return treeRows(output).find((row) => {
    const separator = row.indexOf('\t');
    return separator >= 0 && row.slice(separator + 1) === file;
  });
}

/** Mode of one Git tree entry at this commit, or null when that path is absent. */
function trackedMode(git, commit, file, cache) {
  if (cache.has(file)) return cache.get(file);
  const line = treeEntry(git(['ls-tree', '-z', commit, '--', file]), file);
  const mode = line ? line.slice(0, line.indexOf(' ')) : null;
  cache.set(file, mode);
  return mode;
}
/**
 * Resolve a relative path from a tracked file, one component at a time, against
 * the Git tree. `..` pops only a proven directory. A symlink is never followed.
 */
function resolveGitPath(git, commit, fromFile, relative, cache) {
  requireFact(!posix.isAbsolute(relative), 'publication input escapes repository');
  const stack = posix
    .dirname(fromFile)
    .split('/')
    .filter((part) => part && part !== '.');
  let entered = null;
  const parts = relative.split('/');
  const descendsAfter = (index) =>
    parts.slice(index + 1).some((part) => part !== '' && part !== '.');
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (part === '' || part === '.') {
      if (part === '.' && entered !== null) {
        requireFact(entered === '040000', `${pathComponent}: ${stack.join('/')}`);
      }
      continue;
    }
    if (part === '..') {
      if (entered !== null) {
        requireFact(entered === '040000', `${pathComponent}: ${stack.join('/')}`);
        entered = null;
      }
      requireFact(stack.length > 0, 'publication input escapes repository');
      stack.pop();
      continue;
    }
    if (entered !== null) requireFact(entered === '040000', `${pathComponent}: ${stack.join('/')}`);
    stack.push(part);
    const next = stack.join('/');
    const mode = trackedMode(git, commit, next, cache);
    if (mode === '120000') requireFact(false, `${pathSymlink}: ${next}`);
    if (!mode) {
      const rest = parts.slice(index + 1);
      // A later `..` would climb out of a component the tree does not contain.
      if (rest.some((part) => part === '..')) requireFact(false, `${pathComponent}: ${next}`);
      const missing = [...stack, ...rest.filter((part) => part && part !== '.')].join('/');
      requireFact(false, `publication input must be a regular tracked file: ${missing}`);
    }
    if (descendsAfter(index)) requireFact(mode === '040000', `${pathComponent}: ${next}`);
    entered = mode;
  }
  const target = stack.join('/');
  requireFact(target && !target.startsWith('../'), 'publication input escapes repository');
  requireFact(!relative.endsWith('/') || entered === '040000', `${pathComponent}: ${target}`);
  return target;
}

/** Paths from rustc dep-info dummy rules, with Make's escaped spaces decoded. */
function depInfoPaths(depInfo) {
  const lines = depInfo.split('\n');
  const firstBlank = lines.indexOf('');
  requireFact(firstBlank > 0, compilerObservation);
  const paths = [];
  for (const line of lines.slice(firstBlank + 1)) {
    if (!line || line.startsWith('#') || line.includes(': ')) continue;
    requireFact(line.endsWith(':'), compilerObservation);
    paths.push(line.slice(0, -1).replaceAll('\\ ', ' '));
  }
  requireFact(paths.length > 0, compilerObservation);
  return paths;
}

/** The first local input the compiler could not read, when JSON diagnostics name one. */
function compilerInputFailure(stderr) {
  let missingModule = null;
  for (const line of stderr.split('\n')) {
    if (!line) continue;
    let diagnostic;
    try {
      diagnostic = JSON.parse(line);
    } catch {
      requireFact(false, compilerObservation);
    }
    if ((diagnostic?.$message_type ?? 'diagnostic') !== 'diagnostic') continue;
    if (diagnostic.level !== 'error') continue;
    const unread = /^couldn't read `([^`]+)`/.exec(diagnostic.message ?? '');
    if (unread) return { file: unread[1] };
    if (diagnostic.code?.code === 'E0583') {
      const help = (diagnostic.children ?? []).map((child) => child.message ?? '').join('\n');
      missingModule = /create file "([^"]+)"/.exec(help)?.[1] ?? '';
    }
  }
  return missingModule === null ? null : { file: missingModule };
}

/** Cargo compiler artifacts, rendered diagnostics and the final build result. */
function cargoBuildResult(stdout) {
  const artifacts = [];
  const diagnostics = [];
  let finished = false;
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      requireFact(false, compilerObservation);
    }
    if (message.reason === 'compiler-artifact') artifacts.push(message);
    if (message.reason === 'compiler-message') diagnostics.push(JSON.stringify(message.message));
    if (message.reason === 'build-finished') finished = message.success === true;
  }
  return { artifacts, diagnostics: diagnostics.join('\n'), finished };
}

/** Dep-info files Cargo emitted for one compiler artifact. */
function artifactDepInfoFiles(artifact) {
  const files = new Set();
  for (const filename of artifact.filenames ?? []) {
    const base = posix.basename(filename);
    const withoutExtension = base.replace(/\.(?:rlib|rmeta|so|dylib|dll|a|exe)$/u, '');
    const stems = new Set([base, withoutExtension, withoutExtension.replace(/^lib/u, '')]);
    for (const stem of stems) {
      const candidate = posix.join(posix.dirname(filename), `${stem}.d`);
      if (existsSync(candidate)) files.add(candidate);
    }
  }
  requireFact(files.size > 0, compilerObservation);
  return [...files];
}

/** Materialize exact Git bytes and return Cargo dep-info for the NanoHost test harness. */
function nanoHostDepInfo(repoRoot, sourceCommit) {
  const scratch = mkdtempSync(posix.join(tmpdir(), 'openkit-publication-'));
  try {
    const tree = posix.join(scratch, 'tree');
    const gitCommand = (args) => {
      const result = spawnSync('git', args, {
        cwd: scratch,
        encoding: 'utf8',
        timeout: 60000,
        maxBuffer: 1024 * 1024,
      });
      requireFact(
        !result.error && !result.signal && result.status === 0,
        `repository publication proof unavailable: ${args[0]}`
      );
    };
    gitCommand(['clone', '--quiet', '--no-checkout', '--shared', repoRoot, tree]);
    gitCommand(['-C', tree, 'config', 'core.symlinks', 'false']);
    gitCommand(['-C', tree, 'checkout', '--quiet', '--detach', sourceCommit]);
    const env = {};
    for (const key of ['PATH', 'HOME', 'RUSTUP_HOME', 'CARGO_HOME', 'TMPDIR', 'TEMP', 'TMP'])
      if (typeof process.env[key] === 'string') env[key] = process.env[key];
    env.CARGO_TARGET_DIR = posix.join(scratch, 'target');
    const result = spawnSync(
      'cargo',
      [
        'test',
        '--locked',
        '--offline',
        '--manifest-path',
        'apps/nanohost/Cargo.toml',
        '--bin',
        'nanohost',
        '--no-run',
        '--message-format=json',
      ],
      {
        cwd: tree,
        env,
        encoding: 'utf8',
        timeout: 300000,
        maxBuffer: 32 * 1024 * 1024,
      }
    );
    requireFact(!result.error && !result.signal, compilerObservation);
    const build = cargoBuildResult(result.stdout ?? '');
    if (result.status !== 0) return { depInfos: [], diagnostics: build.diagnostics, failed: true };
    requireFact(build.finished, compilerObservation);
    const manifestPath = posix.join(tree, 'apps/nanohost/Cargo.toml');
    const artifacts = build.artifacts.filter((artifact) => artifact.manifest_path === manifestPath);
    const testBins = artifacts.filter(
      (artifact) =>
        artifact.target?.name === 'nanohost' &&
        artifact.target?.kind?.includes('bin') &&
        artifact.profile?.test === true &&
        typeof artifact.executable === 'string'
    );
    requireFact(testBins.length === 1, compilerObservation);
    const depInfos = [];
    for (const artifact of artifacts)
      for (const file of artifactDepInfoFiles(artifact)) depInfos.push(readFileSync(file, 'utf8'));
    return { depInfos, diagnostics: build.diagnostics };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Prefix one Cargo package-relative input path for validation in the repository tree. */
function nanoHostRepositoryPath(file) {
  requireFact(!posix.isAbsolute(file), 'publication input escapes repository');
  return `apps/nanohost/${file}`;
}

/** Compiler-observed NanoHost inputs, re-proved as tracked Git paths. */
function compilerObservedNanoHostInputs(repoRoot, sourceCommit, git, cache) {
  const observed = nanoHostDepInfo(repoRoot, sourceCommit);
  const failure = compilerInputFailure(observed.diagnostics);
  if (failure) {
    if (!failure.file) requireFact(false, compilerObservation);
    const failurePath = nanoHostRepositoryPath(failure.file);
    resolveGitPath(git, sourceCommit, 'proof-root', failurePath, cache);
    requireFact(
      false,
      `publication input must be a regular tracked file: ${posix.normalize(failurePath)}`
    );
  }
  requireFact(!observed.failed, compilerObservation);
  const inputs = new Set();
  for (const depInfo of observed.depInfos) {
    for (const raw of depInfoPaths(depInfo)) {
      const target = resolveGitPath(
        git,
        sourceCommit,
        'proof-root',
        nanoHostRepositoryPath(raw),
        cache
      );
      inputs.add(target);
    }
  }
  return inputs;
}
/** Observe immutable Git bytes, not checkout files or claims in the evidence snapshot. */
export function publicationInputsAt(repoRoot, sourceCommit) {
  requireFact(commit.test(sourceCommit ?? ''), 'publication proof exact commit');
  const repositoryRoot = posix.resolve(repoRoot);
  const git = (args, input) => {
    const result = spawnSync('git', args, {
      cwd: repositoryRoot,
      input,
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 8 * 1024 * 1024,
    });
    requireFact(
      !result.error && !result.signal && result.status === 0,
      `repository publication proof unavailable: ${args[0]}`
    );
    return result.stdout;
  };
  requireFact(
    git(['rev-parse', `${sourceCommit}^{commit}`]).trim() === sourceCommit,
    'publication proof must name a commit object'
  );
  const read = (file) => {
    const entry = treeEntry(git(['ls-tree', '-z', sourceCommit, '--', file]), file);
    requireFact(
      entry && /^100(?:644|755) blob [a-f0-9]{40}\t/.test(entry),
      `publication input must be a regular tracked file: ${file}`
    );
    return { blob: entry.split(/\s+/)[2], bytes: git(['show', `${sourceCommit}:${file}`]) };
  };
  const workflow = read('.github/workflows/ci.yml').bytes;
  const blocks = new Map(
    [
      ...workflow
        .slice(workflow.indexOf('jobs:\n') + 6)
        .matchAll(/^ {2}([a-z0-9-]+):\n(.*?)(?=^ {2}[a-z0-9-]+:\n|(?![\s\S]))/gms),
    ].map((match) => [match[1], match[2]])
  );
  const jobs = {},
    files = {},
    pending = new Set();
  const publicationJobIds = ['publish-container-images', 'github-release', 'verify-release'];
  // Historical baselines retain their own job set. Native App publications must
  // include the complete producer/consumer closure; a partial split refuses proof.
  if (
    ['build-app-candidate', 'smoke-app-native', 'publish-app-image'].some((name) =>
      blocks.has(name)
    )
  ) {
    publicationJobIds.push(
      'container-image-matrix',
      'build-app-candidate',
      'smoke-app-native',
      'publish-app-image'
    );
  }
  // The admission and attestation gates decide what publishers accept; bind their instructions.
  for (const name of [
    'release-security',
    'attest-release-images',
    'candidate-publication',
    'direct-release-admission',
  ])
    if (blocks.has(name)) publicationJobIds.push(name);
  if (blocks.has('direct-release-admission')) publicationJobIds.push('release-preflight');
  const movedJobs = [
    'candidate-plan',
    'candidate-images',
    'candidate-index',
    ...(blocks.has('candidate-registry') ? ['candidate-registry'] : []),
  ];
  const hasMovedWork = movedJobs.some((name) => blocks.has(name));
  let candidateImageIds;
  if (hasMovedWork) publicationJobIds.push(...movedJobs, 'container-image-matrix');
  for (const name of new Set(publicationJobIds)) {
    const block = blocks.get(name);
    requireFact(typeof block === 'string', `publication job missing: ${name}`);
    jobs[name] = git(['hash-object', '--stdin'], block).trim();
    for (const match of block.matchAll(/\bscripts\/[a-zA-Z0-9_./-]+\.(?:mjs|sh|py)\b/g))
      pending.add(match[0]);
  }
  if (hasMovedWork) {
    pending.add('containers/images.json');
    pending.add('.dockerignore');
    pending.add('Caddyfile');
    const images = JSON.parse(read('containers/images.json').bytes).images.filter((i) => i.release);
    requireFact(images.length > 0, 'candidate image catalog');
    candidateImageIds = images.map((i) => i.id);
    const directories = new Set(
      images.flatMap((i) => [posix.dirname(i.dockerfile), posix.dirname(i.smoke)])
    );
    for (const directory of directories) {
      for (const file of treeRows(
        git(['ls-tree', '-z', '-r', '--name-only', sourceCommit, '--', directory])
      ))
        pending.add(file);
    }
    // These are image-construction programs, not the product source bundled by COPY . . .
    for (const file of treeRows(
      git(['ls-tree', '-z', '-r', '--name-only', sourceCommit, '--', 'scripts'])
    ))
      if (/^scripts\/retrieval-[^/]+\.(?:py|sh)$/.test(file)) pending.add(file);
  }
  // Stable promotion has its own tag-only workflow and must be in the same immutable input proof.
  const promotionWorkflow = '.github/workflows/release-promotion.yml';
  if (git(['ls-tree', sourceCommit, '--', promotionWorkflow]).trim()) {
    jobs['stable-promotion-workflow'] = read(promotionWorkflow).blob;
    pending.add(promotionWorkflow);
  }
  requireFact(pending.size > 0, 'publication jobs have no admitted script inputs');
  const pathModes = new Map();
  const resolvePath = (fromFile, relative) =>
    resolveGitPath(git, sourceCommit, fromFile, relative, pathModes);
  // Current publication scripts use relative static imports and literal URL file reads.
  // Follow that actual dependency closure; a missing or untracked dependency refuses proof.
  for (const file of pending) {
    requireFact(
      !posix.isAbsolute(file) && !file.startsWith('../'),
      'publication input escapes repository'
    );
    const { blob, bytes } = read(file);
    files[file] = blob;
    if (file === 'apps/nanohost/Cargo.toml') {
      requireFact(!/^[\t ]*build[\t ]*=/m.test(bytes), buildScript);
    }
    for (const match of bytes.matchAll(/\bscripts\/[a-zA-Z0-9_./-]+\.(?:mjs|sh|py)\b/g))
      pending.add(match[0]);
    // The Worker seed smoke compiles the NanoHost test harness from this checkout.
    // Bind every tracked package file and the parent manifest Cargo consults,
    // then run the same locked Cargo test-binary build offline in an immutable
    // temporary checkout and bind dep-info for every same-package artifact Cargo
    // emits, including the library target when the test binary uses it. Cargo's
    // default feature resolution is therefore the build's own behavior rather
    // than a parallel reimplementation. Symlinks are materialized as ordinary
    // files, missing local input diagnostics refuse proof, and every listed path
    // is re-proved as a regular tracked Git object one component at a time. A
    // baseline recorded with a smaller closure mismatches and fails closed.
    if (file === 'scripts/docker/check-worker-seed.sh') {
      pending.add('Cargo.toml');
      for (const cargoConfig of ['.cargo/config.toml', '.cargo/config'])
        if (trackedMode(git, sourceCommit, cargoConfig, pathModes)) pending.add(cargoConfig);
      requireFact(
        !/^[\t ]*build[\t ]*=/m.test(read('apps/nanohost/Cargo.toml').bytes),
        buildScript
      );
      for (const tracked of treeRows(
        git(['ls-tree', '-z', '-r', '--name-only', sourceCommit, '--', 'apps/nanohost'])
      )) {
        requireFact(
          !(tracked === 'apps/nanohost/build.rs' || /\/build\.rs$/.test(tracked)),
          buildScript
        );
        pending.add(tracked);
      }
      for (const observed of compilerObservedNanoHostInputs(
        repositoryRoot,
        sourceCommit,
        git,
        pathModes
      ))
        pending.add(observed);
    }
    if (!/\.(?:mjs|js)$/.test(file)) continue;
    for (const match of bytes.matchAll(
      /(\bfrom\s*|\bimport\s*(?:\(\s*)?|\bnew URL\(\s*)['"](\.[^'"]+)['"]/g
    )) {
      // A trailing-slash URL locates a directory (for example a build's cwd),
      // not file bytes. Imports and literal file URLs must still resolve to blobs.
      if (match[1].startsWith('new URL') && match[2].endsWith('/')) continue;
      const dependency = resolvePath(file, match[2]);
      pending.add(dependency);
    }
  }
  const inputs = { jobs, files };
  return {
    ...inputs,
    ...(candidateImageIds ? { candidateImageIds } : {}),
    sha256: sha(canonical(inputs)),
  };
}
/** Skipped or unnamed jobs cannot supply the required real-run proof. */
function successfulJobs(run, names) {
  return (
    Number.isSafeInteger(run?.runId) &&
    run.runId > 0 &&
    run.conclusion === 'success' &&
    Array.isArray(run.jobs) &&
    names.every((name) => {
      const matches = run.jobs.filter((job) => job.name === name);
      return (
        matches.length === 1 &&
        matches[0].conclusion === 'success' &&
        Number.isSafeInteger(matches[0].id) &&
        matches[0].id > 0
      );
    })
  );
}
/** Check every standing-grant predicate; this does not collect evidence or create a tag. */
export function checkPublication(e, { now = new Date(), repoRoot = process.cwd() } = {}) {
  requireFact(e && typeof e === 'object', 'evidence');
  const g = e.grant;
  const direct = isDirectStableTag(e.tag);
  const approved = direct ? directStableGrant(e.tag, e.sha, g?.exactGrant) : undefined;
  if (!direct) requireFact(grantCoversPrerelease(e.tag, g?.firstTag), 'covered prerelease tag');
  requireFact(commit.test(e.sha ?? ''), 'exact P');
  requireFact(
    g?.reference &&
      g.repository === e.repository &&
      e.repository === 'lingkaix/openkit' &&
      g.revoked === false &&
      g.cycleOpen === true,
    'applicable unrevoked grant'
  );
  requireFact(hash.test(e.assetSet ?? '') && e.assetSet === g.assetSet, 'approved asset set');
  const actual = publicationInputsAt(repoRoot, e.sha);
  const baselineInputs = direct ? undefined : publicationInputsAt(repoRoot, e.baseline?.sha);
  requireFact(
    e.publicationInputs === actual.sha256 &&
      (direct
        ? g.publicationInputs === actual.sha256
        : actual.sha256 === baselineInputs.sha256 &&
          g.publicationInputs === baselineInputs.sha256 &&
          e.baseline.publicationInputs === baselineInputs.sha256),
    direct
      ? 'actual repository publication inputs differ from exact grant'
      : 'actual repository publication inputs differ from approved baseline'
  );
  const start = Date.parse(e.observedAt),
    end = Date.parse(e.validUntil);
  requireFact(
    Number.isFinite(start) && Number.isFinite(end) && start <= now.getTime() && now.getTime() < end,
    'fresh bounded evidence window'
  );
  requireFact(
    e.review?.sha === e.sha && typeof e.review.reference === 'string' && e.review.reference.trim(),
    'reviewed P'
  );
  requireFact(e.main?.sha === e.sha && e.main.contained === true, 'P contained in main');
  const c = e.candidate;
  requireFact(
    c?.sha === e.sha &&
      (!direct ||
        (c.runId === approved.runId &&
          c.attempt === approved.attempt &&
          c.ref === 'refs/heads/main')) &&
      Number.isSafeInteger(c.attempt) &&
      c.attempt > 0 &&
      ((c.event === 'push' &&
        c.ref === 'refs/heads/main' &&
        ['release-gate', 'full'].includes(c.gate)) ||
        (c.event === 'workflow_dispatch' && ['release-gate', 'full'].includes(c.gate))) &&
      successfulJobs(c, [
        ...candidateJobs,
        ...(direct ? directCandidateJobs : []),
        ...(actual.candidateImageIds ?? []).map((id) => `Candidate index (${id})`),
      ]),
    'successful exact-P candidate run and jobs'
  );
  if (direct) {
    const proof = e.directProof;
    requireFact(
      proof?.repository === e.repository &&
        proof.sha === e.sha &&
        proof.tag === e.tag &&
        proof.runId === c.runId &&
        proof.attempt === c.attempt &&
        proof.inputs === actual.sha256 &&
        hash.test(proof.checksums ?? '') &&
        now.getTime() < Date.parse(proof.validUntil),
      'current direct stable publication proof'
    );
    const assessment =
      e.tag === 'v0.2.0' ? readReleaseAssessment(repoRoot, e.tag, e.sha) : undefined;
    validateCandidateQualification(proof.qualification, { tag: e.tag, source: e.sha, assessment });
  } else {
    let baselineVersion;
    try {
      baselineVersion = parseVersionTag(e.baseline?.tag ?? '');
    } catch {
      baselineVersion = undefined;
    }
    const baselineJobNames = actual.jobs['smoke-app-native']
      ? [
          ...publicationJobs,
          'Read app candidate',
          'Smoke App native (linux/amd64)',
          'Smoke App native (linux/arm64)',
        ]
      : publicationJobs;
    requireFact(
      baselineVersion &&
        e.baseline.publicationInputs === e.publicationInputs &&
        successfulJobs(e.baseline, baselineJobNames),
      'successful real-tag unchanged-publication baseline'
    );
    const baseline = e.baseline,
      approvedBaseline = g.baseline;
    const baselineIdentityFields = ['repository', 'tag', 'sha', 'workflow', 'runId', 'attempt'];
    requireFact(
      approvedBaseline &&
        typeof approvedBaseline === 'object' &&
        !Array.isArray(approvedBaseline) &&
        Object.keys(approvedBaseline).length === baselineIdentityFields.length + 1 &&
        Object.hasOwn(approvedBaseline, 'kind') &&
        ((approvedBaseline.kind === 'production-tag' &&
          approvedBaseline.repository === e.repository) ||
          (approvedBaseline.kind === 'scratch-rehearsal' &&
            approvedBaseline.repository === 'notrucked/openkit' &&
            baselineVersion.includes('-'))) &&
        approvedBaseline.workflow === '.github/workflows/ci.yml' &&
        baselineIdentityFields.every(
          (field) =>
            Object.hasOwn(approvedBaseline, field) && baseline[field] === approvedBaseline[field]
        ) &&
        baseline.event === 'push' &&
        baseline.ref === `refs/tags/${baseline.tag}` &&
        baseline.resolvedTagSha === baseline.sha &&
        Number.isSafeInteger(baseline.attempt) &&
        baseline.attempt > 0 &&
        baseline.jobs
          .filter((job) => baselineJobNames.includes(job.name))
          .every(
            (job) =>
              job.runId === baseline.runId &&
              job.attempt === baseline.attempt &&
              job.sha === baseline.sha
          ),
      'approved publication baseline identity and tag-push provenance'
    );
  }
  if (actual.candidateImageIds?.length) {
    const r = e.registry;
    requireFact(
      Number.isSafeInteger(r?.artifactId) &&
        r.artifactId > 0 &&
        r?.sha === e.sha &&
        r.tag === e.tag &&
        r.inputs === actual.sha256 &&
        Number.isSafeInteger(r.attempt) &&
        r.attempt > 0 &&
        r.provenance?.runId === r.runId &&
        r.provenance.attempt === r.attempt &&
        r.candidate?.runId === e.candidate.runId &&
        r.candidate.attempt === e.candidate.attempt &&
        ((r.event === 'push' && r.ref === 'refs/heads/main') || r.event === 'workflow_dispatch') &&
        Number.isFinite(Date.parse(r.inspectionStartedAt)) &&
        start <= Date.parse(r.inspectionStartedAt) &&
        Date.parse(r.inspectionStartedAt) <= Date.parse(r.checkedAt) &&
        hash.test(r.recordSha256 ?? '') &&
        r.recordSha256 === e.identities?.registryEvidenceSha256 &&
        Number.isFinite(Date.parse(r.checkedAt)) &&
        start <= Date.parse(r.checkedAt) &&
        Date.parse(r.checkedAt) <= now.getTime() &&
        successfulJobs(r, [registryJob]),
      'fresh exact-P CI registry evidence'
    );
  }
  const identities = e.identities;
  requireFact(
    (identities?.state === 'unused' &&
      identities.tagUnused === true &&
      identities.imagesUnused === true) ||
      (identities?.state === 'same-tag-retry' &&
        identities.sha === e.sha &&
        identities.tag === e.tag &&
        identities.permitted === true &&
        identities.immutableReuseProved === true &&
        identities.reference),
    'unused identities or permitted exact immutable retry'
  );
  const triage = e.triage;
  requireFact(
    triage?.label === 'release-blocker' &&
      triage.reconciled === true &&
      triage.complete === true &&
      Array.isArray(triage.issues),
    'blocker label and reconciled complete triage'
  );
  for (const issue of triage.issues) {
    requireFact(
      Number.isSafeInteger(issue.number) &&
        issue.number > 0 &&
        typeof issue.applicable === 'boolean' &&
        typeof issue.blocker === 'boolean' &&
        ['open', 'closed'].includes(issue.state),
      'finding classification'
    );
    requireFact(
      !(issue.applicable && issue.state === 'open' && issue.blocker),
      `open ${direct ? 'release' : 'prerelease'} blocker #${issue.number}`
    );
    if (issue.applicable && issue.state === 'open')
      requireFact(
        issue.disposition && issue.disclosure && issue.owner,
        `disposition/disclosure/owner #${issue.number}`
      );
  }
  requireFact(
    e.flags?.prerelease === !direct &&
      e.flags.githubLatest === direct &&
      e.flags.ghcrLatest === direct,
    direct ? 'stable flags and Latest' : 'prerelease flags and unchanged Latest'
  );
  return {
    tag: e.tag,
    sha: e.sha,
    grant: g.reference,
    status: 'eligible',
    publicationProof: {
      candidate: actual,
      ...(direct
        ? { scope: e.directProof }
        : { baseline: baselineInputs, baselineCommit: e.baseline.sha }),
    },
    observedAt: e.observedAt,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3)
      throw Error('Usage: node scripts/release-publication-check.mjs EVIDENCE.json');
    console.log(
      JSON.stringify(checkPublication(JSON.parse(readFileSync(process.argv[2], 'utf8'))))
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
