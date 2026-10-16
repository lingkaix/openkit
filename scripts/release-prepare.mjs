#!/usr/bin/env node
/** Generate reviewable release facts and a reconciliation delta; never create release authority or change P. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parseReleaseNotesInput } from './release-notes.mjs';
import {
  command,
  commitAt,
  githubJson,
  issueDelta,
  observeIssues,
  publicText,
  requireRepository,
  validateShaReferences,
} from './release-observe.mjs';
import { publicationInputsAt } from './release-publication-check.mjs';
import { draftReleaseNotes } from './release-record.mjs';
import { canonical, noSecrets, sha } from './release-safety.mjs';

/** Import a complete prior snapshot, or retain explicit issue rows from the existing Markdown record. */
export function previousIssues(bytes) {
  if (bytes.trimStart().startsWith('{')) {
    const value = JSON.parse(bytes);
    if (!Array.isArray(value.issues)) throw Error('Previous reconciliation has no issues');
    return value;
  }
  const rows = bytes.split('\n').filter((line) => /^\| \[#\d+\]\(/.test(line));
  if (!rows.length) throw Error('Previous record has no explicit reconciliation rows');
  const issues = new Map();
  const repositories = new Set();
  for (const row of rows) {
    const match = row.match(
      /^\| \[#(\d+)\]\(https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)\)/
    );
    if (!match || match[1] !== match[3]) throw Error('Invalid prior issue identity');
    repositories.add(match[2]);
    const number = Number(match[1]);
    const issue = issues.get(number) ?? { number, state: 'unobserved', recordRows: [] };
    issue.recordRows.push(sha(row));
    issues.set(number, issue);
  }
  if (repositories.size !== 1) throw Error('Previous record mixes repositories');
  return {
    source: 'reviewed-markdown-record',
    repository: [...repositories][0],
    issues: [...issues.values()],
  };
}

/** Facts stay generated; the human reviews meaning and dispositions without retyping source identities. */
export function notesDraft({ commits, closedIssues, knownIssues }) {
  const changes = [
    ...commits.map((c) => `${publicText(c.subject)} (\`${c.sha}\`).`),
    ...closedIssues.map(
      (i) =>
        `Closed issue #${i.number}: ${publicText(i.title)}. Confirm that its change is included.`
    ),
  ];
  if (!changes.length)
    changes.push('Review the selected range; no commit or issue change was observed.');
  const draft = draftReleaseNotes({
    changes,
    knownIssues: ['Review retained known issues and current dispositions before commitment.'],
  });
  const result = knownIssues?.trim()
    ? `${draft.split('## Known issues')[0]}## Known issues\n\n${knownIssues.trim()}\n`
    : draft;
  return `${parseReleaseNotesInput(result)}\n`;
}

/** Produce an exclusive private bundle; every source SHA comes from an actual Git commit object. */
export function prepareRelease(
  { repository, tag, previousTag, previous, baselineSha, output, root = process.cwd() },
  { issues = observeIssues, read = githubJson } = {}
) {
  requireRepository(repository);
  if (previous.repository !== repository) throw Error('Previous reconciliation repository differs');
  if (
    !/^v\d+\.\d+\.\d+-[a-z0-9][a-z0-9.-]*$/.test(tag ?? '') ||
    !/^v\d+\.\d+\.\d+(?:-[a-z0-9][a-z0-9.-]*)?$/.test(previousTag ?? '')
  )
    throw Error('Explicit lowercase release range required');
  const source = commitAt('HEAD', { cwd: root });
  const previousCommit = commitAt(`refs/tags/${previousTag}`, { cwd: root });
  const baseline = commitAt(baselineSha, { cwd: root });
  const raw = command(
    'git',
    ['log', '--no-merges', '--format=%H%x00%s', `${previousCommit}..${source}`],
    { cwd: root }
  );
  const commits = raw
    ? raw.split('\n').map((line) => {
        const [commit, subject, extra] = line.split('\0');
        if (!subject || extra !== undefined || commitAt(commit, { cwd: root }) !== commit)
          throw Error('Invalid commit-range observation');
        return { sha: commit, subject: publicText(subject) };
      })
    : [];
  const snapshot = issues(repository);
  const delta = issueDelta(previous, snapshot);
  const release = read(`repos/${repository}/releases/tags/${previousTag}`);
  if (!release?.published_at || !Number.isFinite(Date.parse(release.published_at)))
    throw Error('Previous published release observation required');
  const closedIssues = snapshot.issues.filter(
    (i) => i.state === 'closed' && Date.parse(i.closedAt) >= Date.parse(release.published_at)
  );
  const knownIssues = parseReleaseNotesInput(
    command('git', ['show', `${previousCommit}:release-notes/${previousTag}.md`], { cwd: root })
  ).split('## Known issues\n')[1];
  const draft = notesDraft({ commits, closedIssues, knownIssues });
  validateShaReferences(draft, { cwd: root });
  const candidate = publicationInputsAt(root, source);
  const proved = publicationInputsAt(root, baseline);
  const facts = {
    repository,
    tag,
    sourceCommit: source,
    previousTag,
    previousCommit,
    baselineCommit: baseline,
    snapshotSha256: snapshot.sha256,
    commits,
    closedIssues,
    publicationInputs: { candidate, baseline: proved, equal: candidate.sha256 === proved.sha256 },
    delta,
    status: 'draft-requires-meaning-and-disposition-review',
  };
  noSecrets(facts);
  mkdirSync(output, { mode: 0o700 });
  for (const [name, value] of Object.entries({
    'snapshot.json': snapshot,
    'preparation.json': facts,
    'reconciliation-delta.json': delta,
  }))
    writeFileSync(join(output, name), `${JSON.stringify(value, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  writeFileSync(join(output, 'notes-draft.md'), draft, { flag: 'wx', mode: 0o600 });
  return {
    sourceCommit: source,
    issues: snapshot.issues.length,
    changedIssues: delta.length,
    publicationInputsEqual: candidate.sha256 === proved.sha256,
    factsSha256: sha(canonical(facts)),
    status: facts.status,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({
      options: {
        repository: { type: 'string' },
        tag: { type: 'string' },
        'previous-tag': { type: 'string' },
        'previous-record': { type: 'string' },
        'baseline-sha': { type: 'string' },
        output: { type: 'string' },
        validate: { type: 'string' },
      },
    });
    if (values.validate)
      console.log(
        JSON.stringify({
          validatedReferences: validateShaReferences(readFileSync(values.validate, 'utf8')),
        })
      );
    else {
      if (
        ['repository', 'tag', 'previous-tag', 'previous-record', 'baseline-sha', 'output'].some(
          (k) => !values[k]
        )
      )
        throw Error(
          'Release preparation needs repository, tag, previous-tag, previous-record, baseline-sha and a new output directory'
        );
      console.log(
        JSON.stringify(
          prepareRelease({
            repository: values.repository,
            tag: values.tag,
            previousTag: values['previous-tag'],
            previous: previousIssues(readFileSync(values['previous-record'], 'utf8')),
            baselineSha: values['baseline-sha'],
            output: values.output,
          })
        )
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
