/** Inspect the actual Git index or every pushed commit; never retain or print matched values. */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { CREDENTIAL_PATTERN, findCredentialForms } from './credential-patterns.mjs';

/** Read one local Git observation without reflecting failure output into diagnostics. */
function git(repoRoot, args, encoding = 'utf8') {
  try {
    return execFileSync('git', ['-C', repoRoot, ...args], {
      encoding,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw Error('Secret check could not read the selected Git input');
  }
}
/** Preserve Git's NUL-delimited filenames, including whitespace, rather than parsing shell words. */
function names(value) {
  return [...new Set(value.split('\0').filter(Boolean))];
}
/** Resolve an explicitly selected revision, never substitute another commit on failure. */
function commit(repoRoot, ref) {
  if (typeof ref !== 'string' || !ref.trim())
    throw Error('Secret check requires an explicit revision');
  const sha = git(repoRoot, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${ref}^{commit}`,
  ]).trim();
  if (!/^[a-f0-9]{40}$/u.test(sha)) throw Error('Secret check requires a commit identity');
  return sha;
}
/**
 * Scan staged blob bytes or every changed blob in the selected pushed range.
 * @param {{repoRoot: string, staged?: boolean, base?: string, head?: string}} input Git selection.
 * @returns {{file: string, line: number, pattern: string}[]} Value-free diagnostic locations.
 */
export function scanSecrets({ repoRoot, staged = false, snapshot = false, base, head = 'HEAD' }) {
  const selected = [];
  if (snapshot) {
    const revision = commit(repoRoot, head);
    const files = names(git(repoRoot, ['ls-tree', '-r', '--name-only', '-z', revision]));
    for (const file of files) selected.push({ file, object: `${revision}:${file}` });
  } else if (staged) {
    const files = names(
      git(repoRoot, ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
    );
    for (const file of files) selected.push({ file, object: `:${file}` });
  } else {
    const end = commit(repoRoot, head);
    const start = base === '0'.repeat(40) ? undefined : commit(repoRoot, base ?? 'HEAD^');
    const commits = git(repoRoot, ['rev-list', '--reverse', start ? `${start}..${end}` : end])
      .trim()
      .split('\n')
      .filter(Boolean);
    for (const revision of commits) {
      const files = names(
        git(repoRoot, [
          'diff-tree',
          '--root',
          '-m',
          '--no-commit-id',
          '--name-only',
          '--diff-filter=ACMR',
          '-r',
          '-z',
          revision,
        ])
      );
      for (const file of files) selected.push({ file, object: `${revision}:${file}` });
    }
  }
  const locations = [];
  for (const { file, object } of selected) {
    const text = git(repoRoot, ['cat-file', 'blob', object]);
    for (const location of findCredentialForms(text)) locations.push({ file, ...location });
  }
  return locations;
}
/** Escape filenames as data, including runner command delimiters and credential-shaped names. */
export function secretDiagnostic({ file, line, pattern }) {
  const safeFile = JSON.stringify(file.replace(CREDENTIAL_PATTERN, '[redacted]')).replaceAll(
    ':',
    '\\u003a'
  );
  return `${safeFile}:${line}: ${pattern}`;
}

// The combined local/CI check uses the same silent Git observations for its lock/workflow snapshot.
export { commit as gitCommit, git as readGit, names as gitNames };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({
      options: { staged: { type: 'boolean' }, base: { type: 'string' }, head: { type: 'string' } },
    });
    const matches = scanSecrets({ repoRoot: process.cwd(), ...values });
    for (const match of matches) console.error(secretDiagnostic(match));
    process.exitCode = matches.length ? 1 : 0;
  } catch {
    console.error('Secret check could not complete');
    process.exitCode = 1;
  }
}
