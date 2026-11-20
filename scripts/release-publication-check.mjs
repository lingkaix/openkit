#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
/** Offline pre-tag admission over retained, independently collected publication observations. */
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseVersionTag } from './release-preflight.mjs';
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
const rustWhitespace = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0x200e, 0x200f, 0x2028, 0x2029,
]);
const includeRefusal = 'compiled include is not a plain string literal';
const includeMacros = new Set(['include', 'include_str', 'include_bytes']);
const includeClosers = { '(': ')', '[': ']', '{': '}' };
/** Rust Pattern_White_Space and comments, including nested block comments. */
function skipRustTrivia(source, index) {
  let i = index;
  while (i < source.length) {
    if (rustWhitespace.has(source.charCodeAt(i))) {
      i += 1;
      continue;
    }
    if (source.startsWith('//', i)) {
      i += 2;
      while (i < source.length && source.charCodeAt(i) !== 0x0a) i += 1;
      continue;
    }
    if (source.startsWith('/*', i)) {
      const end = skipRustBlockComment(source, i);
      if (end < 0) return -1;
      i = end;
      continue;
    }
    break;
  }
  return i;
}
function skipRustBlockComment(source, index) {
  let depth = 1;
  let i = index + 2;
  while (i < source.length && depth > 0) {
    if (source.startsWith('/*', i)) {
      depth += 1;
      i += 2;
      continue;
    }
    if (source.startsWith('*/', i)) {
      depth -= 1;
      i += 2;
      continue;
    }
    i += 1;
  }
  return depth === 0 ? i : -1;
}
/**
 * Skip one Rust string starting at index.
 * -1 is not a string. -2 is an unterminated string.
 */
function skipRustString(source, index) {
  const match = /^(br|cr|b|c|r)?(#*)"/.exec(source.slice(index));
  if (!match) return -1;
  const prefix = match[1] ?? '';
  const hashes = match[2] ?? '';
  let j = index + match[0].length;
  const raw = prefix.includes('r') || hashes.length > 0;
  if (!raw) {
    while (j < source.length) {
      if (source[j] === '\\') {
        if (j + 1 >= source.length) return -2;
        j += 2;
        continue;
      }
      if (source[j] === '"') return j + 1;
      j += 1;
    }
    return -2;
  }
  const end = source.indexOf(`"${hashes}`, j);
  return end < 0 ? -2 : end + hashes.length + 1;
}
function skipRustChar(source, index) {
  if (source[index] !== "'") return -1;
  let j = index + 1;
  if (j >= source.length) return -1;
  if (source[j] === '\\') {
    if (source[j + 1] === 'u' && source[j + 2] === '{') {
      const close = source.indexOf('}', j + 3);
      if (close < 0) return -1;
      j = close + 1;
    } else if (j + 1 < source.length) j += 2;
    else return -1;
  } else if (source[j] !== "'") j += 1;
  else return -1;
  return source[j] === "'" ? j + 1 : -1;
}
function plainRustString(source, index) {
  const match = /^"((?:\\.|[^"\\\n])*)"/.exec(source.slice(index));
  if (!match) return null;
  return { body: match[1], end: index + match[0].length };
}
/** An identifier, including a raw `r#` prefix. Raw strings are not identifiers. */
function readRustIdent(source, index) {
  let i = index;
  if (source.startsWith('r#', i) && /[A-Za-z_]/.test(source[i + 2] ?? '')) i += 2;
  const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i));
  if (!match) return null;
  return { name: match[0], end: i + match[0].length };
}
const includeEscape = 'compiled include escape is outside the supported subset';
const includeSource = 'compiled include source must be a Rust file';
const includeIndirection = 'compiled include indirection is outside the supported subset';
const modulePathLeaves = 'compiled module path leaves NanoHost';
const buildScript = 'NanoHost build script is outside the supported subset';
const pathSymlink = 'compiled path symlink is outside the supported subset';
const pathComponent = 'compiled path component is outside the supported subset';
/** Mode of one Git tree entry at this commit, or null when that path is absent. */
function trackedMode(git, commit, file, cache) {
  if (cache.has(file)) return cache.get(file);
  const line = git(['ls-tree', commit, '--', file])
    .split('\n')
    .find((row) => row.endsWith(`\t${file}`));
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
  return target;
}
/**
 * Supported include invocation after the macro name.
 * Null when this name is not invoked. Escapes and other forms refuse.
 */
function takeRustInclude(source, index, file, macro, resolvePath) {
  const bang = skipRustTrivia(source, index);
  requireFact(bang >= 0, `${includeRefusal}: ${file}`);
  if (bang >= source.length || source.startsWith('!=', bang) || source[bang] !== '!') return null;
  let cursor = skipRustTrivia(source, bang + 1);
  requireFact(cursor >= 0 && includeClosers[source[cursor]], `${includeRefusal}: ${file}`);
  const closer = includeClosers[source[cursor]];
  cursor = skipRustTrivia(source, cursor + 1);
  requireFact(cursor >= 0, `${includeRefusal}: ${file}`);
  const literal = plainRustString(source, cursor);
  requireFact(literal, `${includeRefusal}: ${file}`);
  requireFact(!literal.body.includes('\\'), `${includeEscape}: ${file}`);
  const close = skipRustTrivia(source, literal.end);
  requireFact(close >= 0 && source[close] === closer, `${includeRefusal}: ${file}`);
  // An absolute literal is rejected before any join, so it cannot bind a namesake.
  requireFact(!posix.isAbsolute(literal.body), 'publication input escapes repository');
  const target = resolvePath(file, literal.body);
  if (macro === 'include') requireFact(target.endsWith('.rs'), `${includeSource}: ${file}`);
  return { target, end: close + 1 };
}
/** use item. An imported include macro is outside the supported subset. */
function consumeUseItem(source, index, file) {
  let i = index;
  let depth = 0;
  while (i < source.length) {
    const token = skipRustTrivia(source, i);
    requireFact(token >= 0, `${includeIndirection}: ${file}`);
    if (token >= source.length) break;
    i = token;
    if (source[i] === ';' && depth === 0) return i + 1;
    if (source[i] === '{') {
      depth += 1;
      i += 1;
      continue;
    }
    if (source[i] === '}') {
      depth -= 1;
      i += 1;
      continue;
    }
    const stringEnd = skipRustString(source, i);
    if (stringEnd === -2) requireFact(false, `${includeIndirection}: ${file}`);
    if (stringEnd >= 0) {
      i = stringEnd;
      continue;
    }
    const ident = readRustIdent(source, i);
    if (ident) {
      requireFact(!includeMacros.has(ident.name), `${includeIndirection}: ${file}`);
      i = ident.end;
      continue;
    }
    i += 1;
  }
  requireFact(false, `${includeIndirection}: ${file}`);
  return i;
}
/** macro_rules body. A metavariable invocation or include name is unsupported. */
function consumeMacroRules(source, index, file) {
  let i = skipRustTrivia(source, index);
  requireFact(i >= 0 && source[i] === '!', `${includeIndirection}: ${file}`);
  i = skipRustTrivia(source, i + 1);
  const name = readRustIdent(source, i);
  requireFact(name, `${includeIndirection}: ${file}`);
  i = skipRustTrivia(source, name.end);
  const closer = includeClosers[source[i]];
  requireFact(closer, `${includeIndirection}: ${file}`);
  const stack = [closer];
  i += 1;
  while (i < source.length && stack.length > 0) {
    const token = skipRustTrivia(source, i);
    requireFact(token >= 0, `${includeIndirection}: ${file}`);
    if (token >= source.length) break;
    i = token;
    const stringEnd = skipRustString(source, i);
    if (stringEnd === -2) requireFact(false, `${includeIndirection}: ${file}`);
    if (stringEnd >= 0) {
      i = stringEnd;
      continue;
    }
    if (includeClosers[source[i]]) {
      stack.push(includeClosers[source[i]]);
      i += 1;
      continue;
    }
    if (source[i] === stack.at(-1)) {
      stack.pop();
      i += 1;
      continue;
    }
    if (source[i] === '$') {
      const metaAt = skipRustTrivia(source, i + 1);
      const meta = metaAt >= 0 ? readRustIdent(source, metaAt) : null;
      if (meta) {
        const bang = skipRustTrivia(source, meta.end);
        if (bang >= 0 && source[bang] === '!' && !source.startsWith('!=', bang)) {
          requireFact(false, `${includeIndirection}: ${file}`);
        }
      }
      i += 1;
      continue;
    }
    const ident = readRustIdent(source, i);
    if (ident) {
      requireFact(!includeMacros.has(ident.name), `${includeIndirection}: ${file}`);
      i = ident.end;
      continue;
    }
    i += 1;
  }
  requireFact(stack.length === 0, `${includeIndirection}: ${file}`);
  return i;
}
/** #[path = "..."] that stays inside apps/nanohost, or null when this is not one. */
function takeModulePath(source, index, file, resolvePath) {
  let i = index + 1;
  if (source[i] === '!') i += 1;
  if (source[i] !== '[') return null;
  i = skipRustTrivia(source, i + 1);
  if (i < 0) return null;
  const ident = readRustIdent(source, i);
  if (!ident || ident.name !== 'path') return null;
  i = skipRustTrivia(source, ident.end);
  requireFact(i >= 0 && source[i] === '=', `${modulePathLeaves}: ${file}`);
  i = skipRustTrivia(source, i + 1);
  const literal = i >= 0 ? plainRustString(source, i) : null;
  requireFact(literal && !literal.body.includes('\\'), `${modulePathLeaves}: ${file}`);
  i = skipRustTrivia(source, literal.end);
  requireFact(i >= 0 && source[i] === ']', `${modulePathLeaves}: ${file}`);
  requireFact(!posix.isAbsolute(literal.body), `${modulePathLeaves}: ${file}`);
  const target = resolvePath(file, literal.body);
  requireFact(target.startsWith('apps/nanohost/'), `${modulePathLeaves}: ${file}`);
  return i + 1;
}
function rustIncludeTargets(source, file, resolvePath) {
  const targets = [];
  const nanohost = file.startsWith('apps/nanohost/');
  let i = 0;
  while (i < source.length) {
    const token = skipRustTrivia(source, i);
    requireFact(token >= 0, `${includeRefusal}: ${file}`);
    if (token >= source.length) break;
    i = token;
    const stringEnd = skipRustString(source, i);
    if (stringEnd === -2) requireFact(false, `${includeRefusal}: ${file}`);
    if (stringEnd >= 0) {
      i = stringEnd;
      continue;
    }
    if (nanohost && source[i] === '#') {
      const attr = takeModulePath(source, i, file, resolvePath);
      if (attr) {
        i = attr;
        continue;
      }
    }
    if (source[i] === "'") {
      if (/^'[A-Za-z_]/.test(source.slice(i, i + 2))) {
        i += 1;
        continue;
      }
      const charEnd = skipRustChar(source, i);
      i = charEnd >= 0 ? charEnd : i + 1;
      continue;
    }
    const ident = readRustIdent(source, i);
    if (ident) {
      if (nanohost && ident.name === 'use') {
        i = consumeUseItem(source, ident.end, file);
        continue;
      }
      if (nanohost && ident.name === 'macro_rules') {
        i = consumeMacroRules(source, ident.end, file);
        continue;
      }
      i = ident.end;
      if (includeMacros.has(ident.name)) {
        const parsed = takeRustInclude(source, i, file, ident.name, resolvePath);
        if (parsed) {
          targets.push(parsed.target);
          i = parsed.end;
        }
      }
      continue;
    }
    i += 1;
  }
  return targets;
}
/** Observe immutable Git bytes, not checkout files or claims in the evidence snapshot. */
export function publicationInputsAt(repoRoot, sourceCommit) {
  requireFact(commit.test(sourceCommit ?? ''), 'publication proof exact commit');
  const git = (args, input) => {
    const result = spawnSync('git', args, {
      cwd: repoRoot,
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
    const entry = git(['ls-tree', sourceCommit, '--', file]);
    requireFact(
      /^100(?:644|755) blob [a-f0-9]{40}\t/.test(entry),
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
  for (const name of ['release-security', 'attest-release-images'])
    if (blocks.has(name)) publicationJobIds.push(name);
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
      for (const file of git(['ls-tree', '-r', '--name-only', sourceCommit, '--', directory])
        .trim()
        .split('\n'))
        if (file) pending.add(file);
    }
    // These are image-construction programs, not the product source bundled by COPY . . .
    for (const file of git(['ls-tree', '-r', '--name-only', sourceCommit, '--', 'scripts'])
      .trim()
      .split('\n'))
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
    // This is a closed supported subset, not a compiler closure. Bind every
    // tracked package file and the parent manifest Cargo consults, then each
    // direct include!, include_str!, or include_bytes! of one plain relative
    // string. A raw r# prefix, a path such as std:: or core::, whitespace,
    // comments, and () [] {} delimiters are that same direct invocation.
    // Escapes are refused and never decoded. include! of a non-.rs file, a use
    // import or macro_rules indirection of these macros, a #[path] module that
    // leaves apps/nanohost, and any NanoHost build script are refused. Absolute
    // literals are rejected before joining. Each relative path is then resolved
    // one component at a time against this commit: a symlink is never followed,
    // and a missing component or a non-directory that must be traversed refuses
    // proof. Ordinary .. through a proven directory still binds. An untracked
    // target refuses proof. A baseline recorded with a smaller closure
    // mismatches and fails closed.
    if (file === 'scripts/docker/check-worker-seed.sh') {
      pending.add('Cargo.toml');
      for (const tracked of git([
        'ls-tree',
        '-r',
        '--name-only',
        sourceCommit,
        '--',
        'apps/nanohost',
      ])
        .trim()
        .split('\n'))
        if (tracked) {
          requireFact(
            !(tracked === 'apps/nanohost/build.rs' || /\/build\.rs$/.test(tracked)),
            buildScript
          );
          pending.add(tracked);
        }
    }
    if (file.endsWith('.rs')) {
      for (const target of rustIncludeTargets(bytes, file, resolvePath)) pending.add(target);
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
  requireFact(grantCoversPrerelease(e.tag, g?.firstTag), 'covered prerelease tag');
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
  const baselineInputs = publicationInputsAt(repoRoot, e.baseline?.sha);
  requireFact(
    actual.sha256 === baselineInputs.sha256 &&
      e.publicationInputs === actual.sha256 &&
      g.publicationInputs === baselineInputs.sha256 &&
      e.baseline.publicationInputs === baselineInputs.sha256,
    'actual repository publication inputs differ from approved baseline'
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
      Number.isSafeInteger(c.attempt) &&
      c.attempt > 0 &&
      ((c.event === 'push' &&
        c.ref === 'refs/heads/main' &&
        ['release-gate', 'full'].includes(c.gate)) ||
        (c.event === 'workflow_dispatch' && ['release-gate', 'full'].includes(c.gate))) &&
      successfulJobs(c, [
        ...candidateJobs,
        ...(actual.candidateImageIds ?? []).map((id) => `Candidate index (${id})`),
      ]),
    'successful exact-P candidate run and jobs'
  );
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
      `open prerelease blocker #${issue.number}`
    );
    if (issue.applicable && issue.state === 'open')
      requireFact(
        issue.disposition && issue.disclosure && issue.owner,
        `disposition/disclosure/owner #${issue.number}`
      );
  }
  requireFact(
    e.flags?.prerelease === true && e.flags.githubLatest === false && e.flags.ghcrLatest === false,
    'prerelease flags and unchanged Latest'
  );
  return {
    tag: e.tag,
    sha: e.sha,
    grant: g.reference,
    status: 'eligible',
    publicationProof: {
      candidate: actual,
      baseline: baselineInputs,
      baselineCommit: e.baseline.sha,
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
