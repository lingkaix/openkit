#!/usr/bin/env node
/** Summarize one targeted gate from its selected files and the actual Vitest JSON report. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE =
  'Usage: node scripts/gate-summary.mjs --report FILE [--not-run FILE] [--root DIR] FILE...\n';

/**
 * Build the four gate lists. A file has a result only when one of its cases passed or failed;
 * an import failure or a failed suite setup leaves a file with no result, which fails the gate.
 * The runner's own unsuccessful report and any reported file outside the selection also fail the gate.
 * A declared group that was not run carries its issue, last measured SHA and result, and no credit.
 */
export function gateSummary({ root = process.cwd(), selected, report, notRun = [] }) {
  if (!Array.isArray(selected) || !selected.length) throw Error('Gate summary: no selected files');
  if (!Array.isArray(report?.testResults)) throw Error('Gate summary: missing Vitest JSON report');
  if (!Array.isArray(notRun)) throw Error('Gate summary: not-run groups must be a list');
  const files = [...new Set(selected.map((file) => resolve(root, file)))].sort();
  const reported = new Map(report.testResults.map((entry) => [entry.name, entry]));
  const unselected = [...reported.keys()].filter((file) => !files.includes(file)).sort();
  const inSelection = [...reported.values()].filter((entry) => files.includes(entry.name));
  const withResult = inSelection
    .filter((entry) =>
      entry.assertionResults?.some((a) => a.status === 'passed' || a.status === 'failed')
    )
    .map((entry) => entry.name)
    .sort();
  const failedAssertions = inSelection.flatMap((entry) =>
    (entry.assertionResults ?? [])
      .filter((a) => a.status === 'failed')
      .map((a) => ({ file: entry.name, name: [...a.ancestorTitles, a.title].join(' > ') }))
  );
  const noResult = files
    .filter((file) => !withResult.includes(file))
    .sort()
    .map((file) => ({
      file,
      cause: reported.has(file)
        ? (reported.get(file).message?.split('\n')[0] ?? '') || 'no passed or failed case'
        : 'not in the report',
    }));
  const groups = notRun.map((group) => ({ ...group, credit: 'none' }));
  const malformed = groups.filter(
    (g) =>
      typeof g.group !== 'string' ||
      !g.group ||
      !/^#\d+$/u.test(g.issue ?? '') ||
      !/^[0-9a-f]{7,40}$/u.test(g.lastMeasuredSha ?? '') ||
      typeof g.lastResult !== 'string' ||
      !g.lastResult
  );
  const runFailures = [];
  if (report.success === false) {
    const outside = report.testResults
      .filter((entry) => entry.status === 'failed' && entry.message)
      .map((entry) => `${entry.name}: ${entry.message.split('\n')[0]}`);
    runFailures.push(
      `the runner reported success false${outside.length ? ` (${outside.join('; ')})` : ''}`
    );
  }
  const failures = [
    ...runFailures,
    ...unselected.map((file) => `report has a result for a file not selected: ${file}`),
    ...noResult.map((entry) => `selected file has no result: ${entry.file} (${entry.cause})`),
    ...failedAssertions.map((entry) => `failed assertion: ${entry.file} > ${entry.name}`),
    ...malformed.map(
      (g) => `not-run group lacks issue, last measured SHA or result: ${JSON.stringify(g)}`
    ),
  ];
  return {
    selected: files,
    withResult,
    failedAssertions,
    notRun: groups,
    noResult,
    unselected,
    pass: !failures.length,
    failures,
  };
}

/** Render the four lists and the gate decision for a log. */
export function formatGateSummary(summary) {
  const list = (title, rows) =>
    [`${title} (${rows.length})`, ...rows.map((row) => `  ${row}`)].join('\n');
  return `${[
    list('Files selected', summary.selected),
    list('Files with a result', summary.withResult),
    list(
      'Failed assertions',
      summary.failedAssertions.map((a) => `${a.file} > ${a.name}`)
    ),
    list(
      'Groups not run (no coverage credit)',
      summary.notRun.map(
        (g) => `${g.group}: ${g.issue}, last measured ${g.lastMeasuredSha} = ${g.lastResult}`
      )
    ),
    summary.pass ? 'Gate: PASS' : list('Gate: FAIL', summary.failures),
  ].join('\n')}\n`;
}

/** Parse the CLI, print the summary and return 0 on pass, 1 on a gate failure, 2 on usage. */
export function main(
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr
) {
  const options = { files: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--report' || flag === '--not-run' || flag === '--root') {
      if (argv[i + 1] === undefined) {
        stderr.write(USAGE);
        return 2;
      }
      options[flag.slice(2)] = argv[++i];
    } else if (flag.startsWith('--')) {
      stderr.write(USAGE);
      return 2;
    } else options.files.push(flag);
  }
  if (!options.report || !options.files.length) {
    stderr.write(USAGE);
    return 2;
  }
  try {
    const summary = gateSummary({
      root: options.root,
      selected: options.files,
      report: JSON.parse(readFileSync(options.report, 'utf8')),
      notRun: options['not-run'] ? JSON.parse(readFileSync(options['not-run'], 'utf8')) : [],
    });
    stdout.write(formatGateSummary(summary));
    return summary.pass ? 0 : 1;
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = main();
