#!/usr/bin/env node
/** Shrink-only census of cache-wide timeline reads.
 * A new getQueriesData( or getQueryCache().findAll( call under the timeline screen
 * or ThreadStream fails. Each site that remains is one named allowlist row with a reason.
 * --refresh-shrink deletes rows whose calls are gone and refuses any new row.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript6';

export const allowlistPath = 'scripts/timeline-cache-read-allowlist.json';
const scope = ['apps/web/src/screens/chat/timeline', 'apps/web/src/screens/chat/ThreadStream.tsx'];

/** The property call, including optional chaining, that this ratchet counts. */
function cacheCallee(expression) {
  const access =
    ts.isPropertyAccessExpression(expression) || ts.isPropertyAccessChain(expression)
      ? expression
      : undefined;
  if (!access) return undefined;
  if (access.name.text === 'getQueriesData') return 'getQueriesData';
  if (access.name.text !== 'findAll' || !ts.isCallExpression(access.expression)) return undefined;
  const inner = access.expression.expression;
  const queryCache =
    ts.isPropertyAccessExpression(inner) || ts.isPropertyAccessChain(inner) ? inner : undefined;
  return queryCache?.name.text === 'getQueryCache' ? 'getQueryCache().findAll' : undefined;
}

/** Call sites in one source file. Comments are not calls. */
export function timelineCacheReadSites(path, text) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const sites = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = cacheCallee(node.expression);
      if (callee) sites.push({ path, callee });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

function counts(sites) {
  const map = new Map();
  for (const site of sites) {
    const key = `${site.path}\t${site.callee}`;
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
}

function validateRow(row) {
  return (
    row &&
    typeof row.path === 'string' &&
    scope.some((root) => row.path === root || row.path.startsWith(`${root}/`)) &&
    (row.callee === 'getQueriesData' || row.callee === 'getQueryCache().findAll') &&
    typeof row.why === 'string' &&
    row.why.trim().length > 0
  );
}

/** Actual calls must match the allowlist. Growth fails. A missing call must be shrunk. */
export function compareTimelineCacheReads(actual, allowed, { shrink = false } = {}) {
  if (!Array.isArray(allowed) || allowed.some((row) => !validateRow(row)))
    return ['Timeline cache-read allowlist rows must name a scoped call and why it remains'];
  const found = counts(actual);
  const kept = counts(allowed);
  const failures = [];
  for (const [key, count] of found) {
    const allowedCount = kept.get(key) ?? 0;
    if (count > allowedCount)
      failures.push(
        `New timeline cache read ${key.replace('\t', ' ')} (${count}, allowlist ${allowedCount})`
      );
  }
  if (!shrink) {
    for (const [key, count] of kept) {
      const actualCount = found.get(key) ?? 0;
      if (count > actualCount)
        failures.push(
          `Stale timeline cache-read allowance ${key.replace('\t', ' ')} (${count}, source ${actualCount}); run --refresh-shrink`
        );
    }
  }
  return failures;
}

/** Drops rows for calls that are gone. Refuses a row the source does not already allow. */
export function shrinkTimelineCacheReads(actual, allowed) {
  const failures = compareTimelineCacheReads(actual, allowed, { shrink: true });
  if (failures.length) return { failures, sites: allowed };
  const remaining = counts(actual);
  const sites = [];
  for (const row of allowed) {
    const key = `${row.path}\t${row.callee}`;
    const left = remaining.get(key) ?? 0;
    if (left < 1) continue;
    remaining.set(key, left - 1);
    sites.push(row);
  }
  return { failures: [], sites };
}

function scopedFiles(root) {
  return execFileSync('git', ['ls-files', '-z', '-c', '-o', '--exclude-standard', '--', ...scope], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((path) => /\.[cm]?[jt]sx?$/.test(path));
}

function scan(root) {
  return scopedFiles(root).flatMap((path) =>
    timelineCacheReadSites(path, readFileSync(resolve(root, path), 'utf8'))
  );
}

function readAllowlist(root) {
  const value = JSON.parse(readFileSync(resolve(root, allowlistPath), 'utf8'));
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.sites))
    throw Error('Invalid timeline cache-read allowlist');
  return value.sites;
}

function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--refresh-shrink'))
    throw Error('Usage: validate-timeline-cache-reads.mjs [--refresh-shrink]');
  const shrink = args.includes('--refresh-shrink');
  const actual = scan(root);
  let allowed = readAllowlist(root);
  if (shrink) {
    const next = shrinkTimelineCacheReads(actual, allowed);
    if (next.failures.length) {
      console.error(next.failures.join('\n'));
      process.exitCode = 1;
      return;
    }
    allowed = next.sites;
    writeFileSync(
      resolve(root, allowlistPath),
      `${JSON.stringify({ schemaVersion: 1, sites: allowed }, null, 2)}\n`
    );
  }
  const failures = compareTimelineCacheReads(actual, allowed);
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log(`Timeline cache reads: PASS (${allowed.length} allowlisted sites; shrink only)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
