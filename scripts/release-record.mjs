#!/usr/bin/env node
import { createHash } from 'node:crypto';
/** Offline manifest, reviewed draft and private closeout projections of existing release evidence. */
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createReleaseNotes, parseReleaseNotesInput } from './release-notes.mjs';
import { noSecrets } from './release-safety.mjs';

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
/** Generate the narrow release asset from existing image JSON, checksums and reviewed assessments. */
export function createReleaseManifest({ repository, tag, sha, images, checksums, assertions }) {
  noSecrets(assertions);
  const fail = (message) => {
    throw Error(`Release Management: manifest refused: ${message}`);
  };
  if (
    !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/u.test(repository ?? '') ||
    !/^v\d+\.\d+\.\d+-[a-z0-9.]+$/u.test(tag ?? '') ||
    !/^[a-f0-9]{40}$/u.test(sha ?? '')
  )
    fail('source identity');
  if (!Array.isArray(images) || images.length === 0) fail('image records');
  const ids = new Set();
  const projected = images
    .map((record) => {
      if (
        !record ||
        !/^[a-z0-9-]+$/u.test(record.id ?? '') ||
        ids.has(record.id) ||
        !/^ghcr\.io\/[a-z0-9._/-]+$/u.test(record.image ?? '') ||
        !SHA256.test(record.digest ?? '') ||
        record.prerelease !== true ||
        !Array.isArray(record.tags) ||
        ![tag, tag.slice(1), `sha-${sha.slice(0, 12)}`].every((t) =>
          record.tags.some((v) => v === t || v === `${record.image}:${t}`)
        )
      )
        fail('image/source binding');
      ids.add(record.id);
      if (
        !Array.isArray(record.platforms) ||
        record.platforms.length !== 2 ||
        !['linux/amd64', 'linux/arm64'].every(
          (p) =>
            record.platforms.filter((v) => v.platform === p && SHA256.test(v.digest ?? ''))
              .length === 1
        )
      )
        fail('platform identity');
      return {
        id: record.id,
        image: record.image,
        digest: record.digest,
        platforms: record.platforms
          .map(({ platform, digest }) => ({ platform, digest }))
          .sort((a, b) => a.platform.localeCompare(b.platform)),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const releasedIds = JSON.parse(
    readFileSync(new URL('../containers/images.json', import.meta.url), 'utf8')
  )
    .images.filter((i) => i.release)
    .map((i) => i.id);
  if (ids.size !== releasedIds.length || !releasedIds.every((id) => ids.has(id)))
    fail('complete catalog image set');
  const expected = [
    `openkit-ops-skill-${tag}.tar.gz`,
    ...['amd64', 'arm64'].map((a) => `openkit-nanohost-${tag}-linux-${a}.tar.gz`),
  ];
  if (typeof checksums !== 'string') fail('portable checksums');
  const assets = checksums
    .trim()
    .split('\n')
    .map((line) => {
      const match = /^([a-f0-9]{64}) {2}([a-zA-Z0-9._-]+)$/u.exec(line);
      if (!match || !expected.includes(match[2])) fail('portable checksum entry');
      return { name: match[2], sha256: match[1] };
    });
  if (
    assets.length !== expected.length ||
    !expected.every((n) => assets.filter((a) => a.name === n).length === 1)
  )
    fail('complete unique portable asset set');
  const app = projected.find((i) => i.id === 'app');
  if (
    !assertions ||
    assertions.sourceCommit !== sha ||
    assertions.appDigest !== app.digest ||
    !SHA256.test(assertions.previousAppImageId ?? '') ||
    assertions.migrationFree !== true ||
    assertions.configurationCompatible !== true ||
    assertions.retainedDataCompatible !== true ||
    assertions.recovery !== 'previous-image-compatible' ||
    typeof assertions.provenance !== 'string' ||
    !/^[a-z0-9-]+$/u.test(assertions.provenance)
  )
    fail('explicit bound compatibility/recovery assertions');
  if (
    Object.keys(assertions).some(
      (k) =>
        ![
          'sourceCommit',
          'appDigest',
          'previousAppImageId',
          'migrationFree',
          'configurationCompatible',
          'retainedDataCompatible',
          'recovery',
          'provenance',
        ].includes(k)
    )
  )
    fail('unknown authority-bearing assertion');
  return {
    schemaVersion: 1,
    repository,
    tag,
    sourceCommit: sha,
    images: projected,
    assets: assets.sort((a, b) => a.name.localeCompare(b.name)),
    assertions,
  };
}

/** Admit only reviewed compatibility facts; source and published digest are joined by the producer. */
export function readReleaseAssessment(repoRoot, tag) {
  if (!/^v\d+\.\d+\.\d+-[a-z0-9.-]+$/u.test(tag))
    throw Error('Release Management: assessment requires a prerelease tag');
  const file = join(repoRoot, 'release-notes', `${tag}.manifest.json`);
  if (!lstatSync(file).isFile())
    throw Error('Release Management: assessment must be a regular reviewed file');
  const facts = JSON.parse(readFileSync(file, 'utf8'));
  noSecrets(facts);
  if (
    !facts ||
    Array.isArray(facts) ||
    Object.keys(facts).sort().join(',') !==
      [
        'previousAppImageId',
        'migrationFree',
        'configurationCompatible',
        'retainedDataCompatible',
        'recovery',
        'provenance',
      ]
        .sort()
        .join(',') ||
    !SHA256.test(facts.previousAppImageId ?? '') ||
    facts.migrationFree !== true ||
    facts.configurationCompatible !== true ||
    facts.retainedDataCompatible !== true ||
    facts.recovery !== 'previous-image-compatible' ||
    !/^[a-z0-9-]+$/u.test(facts.provenance ?? '')
  )
    throw Error(
      'Release Management: reviewed compatibility/recovery assessment is missing or unassessed'
    );
  return facts;
}

/** Produce or independently compare the fifth attachment and its non-circular checksum entry. */
export function publicationManifest({
  repoRoot,
  tag,
  sha,
  repository,
  recordsDir,
  assetsDir,
  verify = false,
}) {
  const name = `openkit-release-${tag}.json`;
  const images = readdirSync(recordsDir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => JSON.parse(readFileSync(join(recordsDir, n), 'utf8')));
  const sumFile = join(assetsDir, 'SHA256SUMS');
  const lines = readFileSync(sumFile, 'utf8').trimEnd().split('\n');
  const selfLines = lines.filter((line) => line.endsWith(`  ${name}`));
  if (selfLines.length !== (verify ? 1 : 0))
    throw Error(
      'Release Management: manifest checksum entry is missing, repeated or already written'
    );
  const archiveLines = lines.filter((line) => !line.endsWith(`  ${name}`));
  const facts = readReleaseAssessment(repoRoot, tag);
  const manifest = createReleaseManifest({
    repository,
    tag,
    sha,
    images,
    checksums: `${archiveLines.join('\n')}\n`,
    assertions: {
      ...facts,
      sourceCommit: sha,
      appDigest: images.find((i) => i.id === 'app')?.digest,
    },
  });
  const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
  const digest = (value) => createHash('sha256').update(value).digest('hex');
  const entry = `${digest(bytes)}  ${name}`;
  if (verify) {
    if (
      selfLines[0] !== entry ||
      !lstatSync(join(assetsDir, name)).isFile() ||
      readFileSync(join(assetsDir, name), 'utf8') !== bytes
    )
      throw Error('Release Management: downloaded manifest differs from publication facts');
    for (const asset of manifest.assets) {
      const file = join(assetsDir, asset.name);
      if (!lstatSync(file).isFile() || digest(readFileSync(file)) !== asset.sha256)
        throw Error('Release Management: downloaded portable checksum mismatch');
    }
  } else {
    writeFileSync(join(assetsDir, name), bytes, { flag: 'wx' });
    writeFileSync(sumFile, `${archiveLines.join('\n')}\n${entry}\n`);
  }
  return manifest;
}

const CHANGES_HEADING = 'Changes since the previous candidate';
const KNOWN_ISSUES_HEADING = 'Known issues';

/** Produce the reviewable two-section draft from accepted changes and carried-forward issues. */
export function draftReleaseNotes({ changes, knownIssues }) {
  const section = (entries, name) => {
    if (
      !Array.isArray(entries) ||
      !entries.length ||
      entries.some((v) => typeof v !== 'string' || !v.trim() || /[\r\n]/u.test(v))
    )
      throw Error(`Release notes draft requires ${name}`);
    return entries.map((v) => `- ${v}`).join('\n');
  };
  return `## ${CHANGES_HEADING}\n\n${section(changes, 'accepted changes')}\n\n## ${KNOWN_ISSUES_HEADING}\n\n${section(knownIssues, 'known-issue dispositions')}\n`;
}

/** Project only bounded public header fields and kit-generated rows into the existing release notes. */
export function compactReleaseRecord({ tag, sha, header, qualification }) {
  if (
    !/^v\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/u.test(tag ?? '') ||
    !/^[a-f0-9]{40}$/u.test(sha ?? '') ||
    !header ||
    !/^[a-z0-9-]+$/u.test(header.authorizationReference ?? '') ||
    header.sourceCommit !== sha ||
    header.tag !== tag ||
    !Number.isSafeInteger(header.candidateRunId) ||
    header.candidateRunId < 1 ||
    !['public', 'private'].includes(header.visibility) ||
    !Array.isArray(header.stages)
  )
    throw Error('Release Management: incomplete compact release header');
  const lines = [
    '## Compact Release Record',
    '',
    `- Publication authority: \`${header.authorizationReference}\``,
    `- Exact-P candidate run: \`${header.candidateRunId}\``,
    `- Publication visibility: \`${header.visibility}\``,
    '',
    '| Stage | Result | UTC window |',
    '| --- | --- | --- |',
  ];
  for (const stage of header.stages) {
    if (
      !['candidate', 'publication', 'app', 'nanohost', 'worker', 'qualification'].includes(
        stage.name
      ) ||
      !['passed', 'failed', 'unknown', 'not-run'].includes(stage.result) ||
      !Number.isFinite(Date.parse(stage.start)) ||
      !Number.isFinite(Date.parse(stage.end)) ||
      Date.parse(stage.end) < Date.parse(stage.start)
    )
      throw Error('Release Management: invalid release stage observation');
    lines.push(
      `| ${stage.name} | ${stage.result} | ${new Date(stage.start).toISOString()}/${new Date(stage.end).toISOString()} |`
    );
  }
  if (qualification) {
    if (
      !Array.isArray(qualification.publicRows) ||
      qualification.publicRows.length !== 16 ||
      new Set(qualification.publicRows.map((r) => r.subject)).size !== 16
    )
      throw Error('Release Management: incomplete qualification projection');
    lines.push(
      '',
      '| Case | Published identity | Result / classification | Exact component identities | UTC window | Evidence |',
      '| --- | --- | --- | --- | --- | --- |'
    );
    for (const row of qualification.publicRows) {
      if (
        !/^(codex|pi|opencode|deepseek)\.[A-D]$/u.test(row.subject) ||
        row.publishedIdentity !== tag ||
        row.sourceCommit !== sha ||
        !['P', 'K', 'E', 'N', 'T', 'I', 'unclassified'].includes(row.verdict) ||
        !Number.isFinite(Date.parse(row.start)) ||
        !Number.isFinite(Date.parse(row.end)) ||
        Date.parse(row.end) < Date.parse(row.start) ||
        !/^[a-z0-9-]+$/u.test(row.evidenceAlias) ||
        !SHA256.test(row.evidenceDigest ?? '') ||
        !['app', 'web', 'nanoHost', 'worker', 'configuration'].every((k) =>
          SHA256.test(row.identities?.[k] ?? '')
        )
      )
        throw Error('Release Management: invalid public qualification row');
      lines.push(
        `| ${row.subject} | ${tag}; ${sha} | ${row.verdict}; ${{ P: 'pass', K: 'known defect', E: 'accepted external', N: 'new defect', T: 'environment or tool failure', I: 'inconclusive', unclassified: 'undecidable' }[row.verdict]} | ${['app', 'web', 'nanoHost', 'worker', 'configuration'].map((k) => `${k}=${row.identities[k]}`).join('; ')} | ${new Date(row.start).toISOString()}/${new Date(row.end).toISOString()} | ${row.evidenceAlias}; ${row.evidenceDigest} |`
      );
    }
  }
  return lines.join('\n');
}

/** Compose a private closeout from the unchanged published-notes producer. */
export function createReleaseRecord(input) {
  const notes = createReleaseNotes(input);
  if (!input.header) return notes;
  return `${notes.trimEnd()}\n\n${compactReleaseRecord({
    tag: input.tag,
    sha: input.sha,
    header: input.header,
    qualification: input.qualification,
  })}\n`;
}
/** Run only record, draft and manifest branches; publication continues to invoke release-notes.mjs. */
function main() {
  const { values: args } = parseArgs({
    options: Object.fromEntries(
      [
        'publication-assets',
        'verify-publication-assets',
        'repo-root',
        'tag',
        'draft-input',
        'manifest-output',
        'compare-manifest',
        'records',
        'repository',
        'sha',
        'checksum-file',
        'assertions',
        'checksum',
        'visibility',
        'run-url',
        'header',
        'qualification-summary',
        'output',
      ].map((name) => [name, { type: 'string' }])
    ),
  });
  const tag = args.tag ?? '';
  if (!tag) throw Error('Release record tag is required.');
  const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
  if (args['publication-assets'] || args['verify-publication-assets']) {
    publicationManifest({
      repoRoot: args['repo-root'] ?? process.cwd(),
      tag,
      sha: args.sha,
      repository: args.repository,
      recordsDir: args.records,
      assetsDir: args['publication-assets'] ?? args['verify-publication-assets'],
      verify: Boolean(args['verify-publication-assets']),
    });
    return;
  }
  if (args['draft-input']) {
    if (!args.output) throw Error('Release record output path is required.');
    const draft = draftReleaseNotes(json(args['draft-input']));
    parseReleaseNotesInput(draft);
    writeFileSync(args.output, draft);
    return;
  }
  if (args['manifest-output'] || args['compare-manifest']) {
    const manifest = createReleaseManifest({
      repository: args.repository,
      tag,
      sha: args.sha,
      images: readdirSync(args.records)
        .filter((n) => n.endsWith('.json'))
        .map((n) => json(join(args.records, n))),
      checksums: readFileSync(args['checksum-file'], 'utf8'),
      assertions: json(args.assertions),
    });
    const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
    if (args['compare-manifest']) {
      if (readFileSync(args['compare-manifest'], 'utf8') !== bytes)
        throw Error('Downloaded release manifest differs from the generated publication facts.');
    } else writeFileSync(args['manifest-output'], bytes);
    return;
  }
  if (!args.output) throw Error('Release record output path is required.');
  writeFileSync(
    args.output,
    createReleaseRecord({
      tag,
      sha: args.sha,
      repoRoot: args['repo-root'] ?? process.cwd(),
      recordsDir: args.records,
      checksum: args.checksum,
      visibility: args.visibility,
      runUrl: args['run-url'],
      header: args.header ? json(args.header) : undefined,
      qualification: args['qualification-summary']
        ? json(args['qualification-summary'])
        : undefined,
    })
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
