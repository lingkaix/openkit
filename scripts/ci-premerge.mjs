#!/usr/bin/env node
/** Validate the exact branch head before an explicitly requested ordinary fast-forward of main. */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { shardPlan } from './ci-l0-l2.mjs';
import {
  command,
  commitAt,
  githubJson,
  observeRun,
  requireOrigin,
  requireRepository,
} from './release-observe.mjs';
import { candidateJobs } from './release-publication-check.mjs';

/** Refuse any changed branch or main observation before an external branch update. */
export function validateMergeSnapshot({
  sha,
  branchSha,
  expectedMain,
  currentMain,
  ancestor,
  clean,
}) {
  if (
    !/^[a-f0-9]{40}$/.test(sha ?? '') ||
    !/^[a-f0-9]{40}$/.test(expectedMain ?? '') ||
    branchSha !== sha ||
    expectedMain !== currentMain ||
    ancestor !== true ||
    clean !== true
  )
    throw Error('Pre-merge source or main changed; select and validate the exact head again');
}

/** Dispatch and inspect one exact-head release gate; only --merge can update main. */
export function premerge(
  { repository, branch, runId, merge = false },
  { run = command, read = githubJson, observe = observeRun } = {}
) {
  requireRepository(repository);
  requireOrigin(repository, { run });
  if (!branch || branch === 'main') throw Error('Explicit non-main source branch required');
  run('git', ['check-ref-format', `refs/heads/${branch}`]);
  if (run('git', ['status', '--porcelain', '--untracked-files=normal']))
    throw Error('Commit the reviewed worktree before pre-merge validation');
  const source = commitAt('HEAD');
  const branchHead = () => {
    const lines = run('git', ['ls-remote', 'origin', `refs/heads/${branch}`]).split('\n');
    if (lines.length !== 1 || lines[0].split(/\s+/)[1] !== `refs/heads/${branch}`)
      throw Error('Unambiguous remote branch head required');
    return lines[0].split(/\s+/)[0];
  };
  const mainHead = () => read(`repos/${repository}/git/ref/heads/main`).object.sha;
  const expectedMain = mainHead();
  if (branchHead() !== source) throw Error('Remote branch is not the reviewed local HEAD');
  run('git', ['fetch', 'origin', 'main']);
  run('git', ['merge-base', '--is-ancestor', expectedMain, source]);
  if (!runId) {
    const text = run('gh', [
      'workflow',
      'run',
      'ci.yml',
      '--repo',
      repository,
      '--ref',
      branch,
      '-f',
      'gate=release-gate',
    ]);
    const matches = [...text.matchAll(/https:\/\/github\.com\/([^\s]+)\/actions\/runs\/(\d+)/g)];
    if (matches.length !== 1 || matches[0][1] !== repository)
      throw Error('Dispatch result unknown; inspect Actions before another request');
    runId = Number(matches[0][2]);
    run('gh', ['run', 'watch', String(runId), '--repo', repository, '--exit-status'], {
      timeout: 14400000,
    });
  }
  const required = [...candidateJobs, ...shardPlan().map((s) => `L0-L2 shard (${s.id})`)];
  const proof = observe({ repository, sha: source, runId, branch, required });
  validateMergeSnapshot({
    sha: source,
    branchSha: branchHead(),
    expectedMain,
    currentMain: mainHead(),
    ancestor: true,
    clean: !run('git', ['status', '--porcelain', '--untracked-files=normal']),
  });
  if (commitAt('HEAD') !== source) throw Error('Local HEAD changed after CI');
  if (merge) {
    requireOrigin(repository, { run });
    // The ordinary non-force push also rejects a conflicting main advance after the final observation.
    run('git', ['push', '--no-follow-tags', '--porcelain', 'origin', `${source}:refs/heads/main`]);
    if (mainHead() !== source) throw Error('Main update result unknown; inspect before retry');
  }
  return { sha: source, branch, expectedMain, candidate: proof, mainUpdated: merge };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({
      options: {
        repository: { type: 'string' },
        branch: { type: 'string' },
        run: { type: 'string' },
        merge: { type: 'boolean', default: false },
      },
    });
    console.log(
      JSON.stringify(
        premerge({
          repository: values.repository,
          branch: values.branch,
          runId: values.run ? Number(values.run) : undefined,
          merge: values.merge,
        })
      )
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
