#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkWorkflows } from './check-workflows.mjs';
import { NANOHOST_TARGETS } from './lib/nanohost-elf.mjs';
import { readReleaseNotesInput } from './release-notes.mjs';
import { canonical, sha as digestHex, noSecrets } from './release-safety.mjs';

const drizzleScopes = ['app', 'core', 'user', 'workspace'];
const drizzleRoot = 'apps/nanocore/drizzle';
const hasExactKeys = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

/**
 * Validates release identity, portable inputs, image manifest, and optional main-branch ancestry.
 *
 * @param {object} input Validation input.
 * @param {string} input.repoRoot Repository root.
 * @param {string} input.tag Git tag name such as v0.0.1.
 * @param {boolean} [input.requireMain] Whether the tag commit must be contained in mainRef.
 * @param {string} [input.mainRef] Git ref that represents main.
 * @param {string} [input.sha] Commit sha for main ancestry validation.
 * @param {boolean} [input.requirePrerelease] Whether the tag must identify a prerelease.
 * @param {boolean} [input.requireReleaseManifestAssessment] Require reviewed release assessment before publication.
 * @param {boolean} [input.requireReleaseImageDigests] Whether release image base images must be digest-pinned.
 * @param {string} [input.promotionSourceTag] Published prerelease whose bytes a stable tag promotes.
 * @param {string} [input.repository] Exact publication repository.
 * @param {string} [input.authorization] Engineer-authorized stable tag and commit, joined with @.
 * @param {object} [observations] Transport adapter for deterministic verification.
 * @param {Function} [observations.predecessor] Reader for the published predecessor.
 * @returns {{ version: string, releaseImages: string[], promotionSourceTag?: string }} Release summary.
 */
export function validateReleasePreflight(input, { predecessor = readPublishedPredecessor } = {}) {
  const repoRoot = resolve(input.repoRoot);
  const version = parseVersionTag(input.tag);

  if (input.requireMain) {
    assertTagOnMain(repoRoot, input.sha, input.mainRef ?? 'origin/main');
  }
  if (input.promotionSourceTag && version.includes('-'))
    throw Error('Release Management: a promotion target must be stable');
  if (!version.includes('-') && (input.requirePrerelease || input.promotionSourceTag)) {
    if (!input.promotionSourceTag)
      throw new Error(
        `Release tag must identify a prerelease until stable-release blockers close: ${input.tag}`
      );
    validateStablePromotionIdentity({ ...input, sourceTag: input.promotionSourceTag });
  }

  if (input.requireReleaseManifestAssessment) {
    const sourceTag = input.promotionSourceTag ?? input.tag;
    const facts = readReleaseAssessment(repoRoot, sourceTag);
    if (input.promotionSourceTag && !compatibleTransitionFacts(facts))
      throw Error('Release Management: a pre-stable reset prerelease is not a stable source');
    if (compatibleTransitionFacts(facts)) {
      const previous = predecessor(releaseRepository(repoRoot, input.repository), sourceTag);
      if (
        facts.previousAppImageId !== previous.appImageId ||
        (facts.forwardMigration && facts.forwardMigration.previousTag !== previous.tag)
      )
        throw Error(
          'Release Management: assessment differs from the published predecessor tag or App image ID'
        );
      checkMigrationLedgers(repoRoot, sourceTag, input.sha, previous, facts.forwardMigration);
      if (facts.forwardMigration) readReleaseNotesInput(repoRoot, sourceTag);
    }
  }
  validatePortableReleaseInputs(repoRoot);
  validateNanoHostReleaseInputs(repoRoot);
  const releaseImages = validateImageManifest(repoRoot, Boolean(input.requireReleaseImageDigests));

  return {
    version,
    releaseImages,
    ...(input.promotionSourceTag ? { promotionSourceTag: input.promotionSourceTag } : {}),
  };
}

/** Require the engineer's exact tag/commit authorization; no standing prerelease grant admits stable publication. */
export function validateStablePromotionIdentity({
  repository,
  tag,
  sha,
  sourceTag,
  authorization,
}) {
  const version = parseVersionTag(tag);
  const sourceVersion = parseVersionTag(sourceTag);
  if (
    version.includes('-') ||
    !sourceVersion.startsWith(`${version}-`) ||
    !/^[a-f0-9]{40}$/u.test(sha ?? '')
  )
    throw Error(
      'Release Management: stable promotion requires the same version and exact source commit'
    );
  const scratch = repository === 'notrucked/openkit' && /^0\.0\.(?:0|[1-9]\d*)$/u.test(version);
  if (!scratch && !(repository === 'lingkaix/openkit' && authorization === `${tag}@${sha}`))
    throw Error(
      'Release Management: stable publication requires exact engineer authorization after stable blockers close'
    );
}

/**
 * Parses a release tag into the product version value.
 *
 * @param {string} tag Tag name.
 * @returns {string} Version without leading v.
 */
export function parseVersionTag(tag) {
  const match =
    /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9a-z-]*[a-z-][0-9a-z-]*)(?:\.(?:0|[1-9]\d*|[0-9a-z-]*[a-z-][0-9a-z-]*))*)?)$/.exec(
      tag
    );
  if (!match) {
    throw new Error(
      `Release tag must match v<major>.<minor>.<patch> or v<major>.<minor>.<patch>-<pre>: ${tag}`
    );
  }
  return match[1];
}

/** Verify the closed forward-migration assertion before it can be included in a manifest. */
function validForwardMigration(migration) {
  if (
    !hasExactKeys(migration, [
      'previousTag',
      'ledgers',
      'preUpdateBackupRequired',
      'recoveryLimits',
    ]) ||
    migration.preUpdateBackupRequired !== true ||
    !hasExactKeys(migration.recoveryLimits, [
      'workspaceOperationalBackup',
      'coldDataRootBackup',
      'rollback',
    ]) ||
    migration.recoveryLimits.workspaceOperationalBackup !== 'creating-build-only' ||
    migration.recoveryLimits.coldDataRootBackup !== 'cross-release-forward-migration' ||
    migration.recoveryLimits.rollback !== 'restore-pre-update-backup-on-previous-build' ||
    !Array.isArray(migration.ledgers) ||
    migration.ledgers.length === 0
  )
    return false;
  try {
    parseVersionTag(migration.previousTag);
  } catch {
    return false;
  }
  return (
    migration.ledgers.every(
      (entry) =>
        hasExactKeys(entry, ['ledger', 'from', 'to']) &&
        drizzleScopes.some((scope) => entry.ledger === `drizzle.${scope}`) &&
        Number.isSafeInteger(entry.from) &&
        entry.from > 0 &&
        Number.isSafeInteger(entry.to) &&
        entry.to > entry.from
    ) && new Set(migration.ledgers.map(({ ledger }) => ledger)).size === migration.ledgers.length
  );
}

/** Compatible sources preserve configuration and retained data, with their declared recovery limits. */
export function compatibleTransitionFacts(facts) {
  if (facts?.configurationCompatible !== true || facts.retainedDataCompatible !== true)
    return false;
  if (facts.migrationFree === true)
    return (
      facts.recovery === 'previous-image-compatible' && !Object.hasOwn(facts, 'forwardMigration')
    );
  return (
    facts.migrationFree === false &&
    facts.recovery === 'restore-pre-update-backup' &&
    validForwardMigration(facts.forwardMigration)
  );
}

/** Before v0.1.0, a prerelease may also disclose a reset without retained-data continuity. */
export function admittedTransitionFacts(facts, tag) {
  if (compatibleTransitionFacts(facts)) return facts.forwardMigration?.previousTag !== tag;
  const [core, prerelease] = parseVersionTag(tag).split(/-(.*)/su);
  const [major, minor, patch] = core.split('.').map(Number);
  return (
    Boolean(prerelease) &&
    major === 0 &&
    (minor === 0 || (minor === 1 && patch === 0)) &&
    facts?.migrationFree === false &&
    typeof facts.configurationCompatible === 'boolean' &&
    facts.retainedDataCompatible === false &&
    facts.recovery === 'pre-stable-reset' &&
    !Object.hasOwn(facts, 'forwardMigration')
  );
}

const sha256 = /^sha256:[a-f0-9]{64}$/u;
const commitSha = /^[a-f0-9]{40}$/u;
const githubRepository = /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/u;

function releaseRepository(repoRoot, repository) {
  if (!repository) {
    const remote = spawnSync('git', ['remote', 'get-url', 'origin'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    repository = remote.stdout
      ?.trim()
      .match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/u)?.[1];
  }
  if (!githubRepository.test(repository ?? ''))
    throw Error('Release Management: exact GitHub release repository required');
  return repository;
}

/** Read the independently published predecessor and its exact amd64 App config identity. */
export async function observePublishedPredecessor(repository, sourceTag, request = fetch) {
  if (!githubRepository.test(repository)) throw Error('GitHub release repository required');
  parseVersionTag(sourceTag);
  const [owner] = repository.toLowerCase().split('/');
  // A hosted read-only job may read its own private packages. Local public observation is anonymous.
  const token =
    process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_REPOSITORY === repository
      ? process.env.GH_TOKEN
      : undefined;
  const githubHeaders = token ? { Authorization: `Bearer ${token}` } : {};
  const read = async (url, headers = {}, redirect = 'error') => {
    const response = await request(url, { headers, redirect, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Error('Published release evidence unavailable');
    return Buffer.from(await response.arrayBuffer());
  };
  const api = `https://api.github.com/repos/${repository}`;
  const releases = [];
  for (let page = 1; ; page++) {
    if (page > 20) throw Error('Published release listing exceeds the observation limit');
    const batch = JSON.parse(
      await read(`${api}/releases?per_page=100&page=${page}`, githubHeaders)
    );
    if (!Array.isArray(batch)) throw Error('Published release listing invalid');
    releases.push(...batch.filter((release) => release.draft === false));
    if (batch.length < 100) break;
  }
  const releaseTime = (release) => Date.parse(release.published_at);
  if (
    new Set(releases.map((release) => release.tag_name)).size !== releases.length ||
    releases.some((release) => !Number.isFinite(releaseTime(release)))
  )
    throw Error('Published release order is ambiguous');
  const source = releases.find((release) => release.tag_name === sourceTag);
  const predecessors = releases
    .filter((release) => !source || releaseTime(release) < releaseTime(source))
    .sort((a, b) => releaseTime(b) - releaseTime(a));
  const previous = predecessors[0];
  if (
    !previous ||
    (source &&
      releases.some(
        (release) => release !== source && releaseTime(release) === releaseTime(source)
      )) ||
    (predecessors[1] && releaseTime(previous) === releaseTime(predecessors[1]))
  )
    throw Error('One previous published release required');

  const tag = previous.tag_name;
  const prerelease = parseVersionTag(tag).includes('-');
  // Stable promotion preserves its source prerelease attachment names and bytes.
  const manifestTag = (name) => /^openkit-release-(v[0-9a-z.-]+)\.json$/u.exec(name)?.[1];
  const attachments = previous.assets?.filter(({ name }) => {
    const attachedTag = manifestTag(name);
    return attachedTag === tag || (!prerelease && attachedTag?.startsWith(`${tag}-`));
  });
  const asset = attachments?.[0];
  if (attachments?.length !== 1 || !Number.isSafeInteger(asset.id) || !sha256.test(asset.digest))
    throw Error('Published predecessor manifest attachment required');
  const attachedTag = manifestTag(asset.name);
  parseVersionTag(attachedTag);
  const bytes = await read(
    `${api}/releases/assets/${asset.id}`,
    { ...githubHeaders, Accept: 'application/octet-stream' },
    'follow'
  );
  if (`sha256:${digestHex(bytes)}` !== asset.digest)
    throw Error('Published predecessor manifest attachment digest differs');
  const manifest = JSON.parse(bytes);
  const apps = manifest.images?.filter((image) => image.id === 'app');
  const app = apps?.[0];
  const image = `${owner}/openkit-app`;
  const platforms = app?.platforms?.filter((entry) => entry.platform === 'linux/amd64');
  const platformDigest = platforms?.[0]?.digest;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.repository !== repository ||
    manifest.tag !== attachedTag ||
    !commitSha.test(manifest.sourceCommit ?? '') ||
    apps?.length !== 1 ||
    app.image !== `ghcr.io/${image}` ||
    platforms?.length !== 1 ||
    !sha256.test(platformDigest ?? '')
  )
    throw Error('Published predecessor App manifest binding differs');

  let ref = JSON.parse(await read(`${api}/git/ref/tags/${tag}`, githubHeaders)).object;
  for (let depth = 0; depth < 8 && ref?.type === 'tag' && commitSha.test(ref.sha); depth++)
    ref = JSON.parse(await read(`${api}/git/tags/${ref.sha}`, githubHeaders)).object;
  if (ref?.type !== 'commit' || ref.sha !== manifest.sourceCommit)
    throw Error('Published predecessor tag differs from the attached manifest');

  const actor = process.env.GITHUB_ACTOR;
  const registryAuth =
    token && owner !== 'lingkaix'
      ? { Authorization: `Basic ${Buffer.from(`${actor}:${token}`).toString('base64')}` }
      : {};
  const scope = encodeURIComponent(`repository:${image}:pull`);
  const ghcr = 'https://ghcr.io';
  const registryToken = JSON.parse(
    await read(`${ghcr}/token?service=ghcr.io&scope=${scope}`, registryAuth)
  ).token;
  if (typeof registryToken !== 'string' || !registryToken)
    throw Error('Published App registry token unavailable');
  const platformBytes = await read(`${ghcr}/v2/${image}/manifests/${platformDigest}`, {
    Authorization: `Bearer ${registryToken}`,
    Accept:
      'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json',
  });
  if (`sha256:${digestHex(platformBytes)}` !== platformDigest)
    throw Error('Published predecessor platform digest differs');
  const appImageId = JSON.parse(platformBytes).config?.digest;
  if (!sha256.test(appImageId ?? ''))
    throw Error('Published predecessor App config digest required');
  return { tag, sourceCommit: manifest.sourceCommit, appImageId };
}

/** Keep existing synchronous preflight callers while the isolated observation uses Node HTTPS. */
function readPublishedPredecessor(repository, sourceTag) {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {observePublishedPredecessor} from ${JSON.stringify(import.meta.url)};
try { console.log(JSON.stringify(await observePublishedPredecessor(...process.argv.slice(1)))); }
catch { process.exitCode = 1; }`,
      repository,
      sourceTag,
    ],
    { encoding: 'utf8', timeout: 120000 }
  );
  if (result.status !== 0)
    throw Error('Release Management: published predecessor observation unavailable');
  return JSON.parse(result.stdout);
}

/** Preflight has full tag history. Verify the journal prefixes and the exact appended SQL in Git. */
function checkMigrationLedgers(repoRoot, tag, sha, predecessor, migration) {
  const fail = (reason) => {
    throw Error(`Release Management: migration ledger mismatch: ${reason}`);
  };
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
    if (result.status !== 0) fail('required release Git evidence unavailable');
    return result.stdout.trim();
  };
  const previous = git('rev-parse', '--verify', `refs/tags/${predecessor.tag}^{commit}`);
  if (previous !== predecessor.sourceCommit)
    fail('local predecessor tag differs from the published source');
  const candidate = git('rev-parse', '--verify', 'HEAD^{commit}');
  if (previous === candidate || (sha && sha !== candidate))
    fail(`expected distinct previous tag and exact checkout of ${tag}`);
  const ledgers = [];
  const expectedSql = [];
  for (const scope of drizzleScopes) {
    const journal = (ref) => {
      const { entries, ...other } = JSON.parse(
        git('show', `${ref}:${drizzleRoot}/${scope}/meta/_journal.json`)
      );
      if (
        !Array.isArray(entries) ||
        entries.length === 0 ||
        entries.some(
          (entry, idx) =>
            entry?.idx !== idx ||
            !/^[0-9]{4}_[a-z0-9_]+$/u.test(entry.tag ?? '') ||
            Number(entry.tag.slice(0, 4)) !== idx ||
            !Number.isSafeInteger(entry.when) ||
            (idx > 0 && entry.when <= entries[idx - 1].when)
        )
      )
        fail(`invalid drizzle.${scope} journal`);
      return { entries, other };
    };
    const before = journal(previous);
    const after = journal(candidate);
    const from = before.entries.length;
    const to = after.entries.length;
    if (
      canonical(before.other) !== canonical(after.other) ||
      canonical(before.entries) !== canonical(after.entries.slice(0, from))
    )
      fail(`drizzle.${scope} journal does not preserve its existing prefix`);
    if (to === from) continue;
    ledgers.push({ ledger: `drizzle.${scope}`, from, to });
    for (const entry of after.entries.slice(from))
      expectedSql.push(`A\t${drizzleRoot}/${scope}/${entry.tag}.sql`);
  }
  const sql = git(
    'diff',
    '--name-status',
    '--no-renames',
    previous,
    candidate,
    '--',
    `:(glob)${drizzleRoot}/*/*.sql`
  );
  if (sql !== expectedSql.sort().join('\n'))
    fail('SQL changes differ from the appended journal entries');
  if (!migration && ledgers.length) fail('migration-free assessment has a nonempty migration diff');
  const declared = (migration?.ledgers ?? []).toSorted((a, b) => a.ledger.localeCompare(b.ledger));
  if (canonical(declared) !== canonical(ledgers))
    fail('declared from/to counts differ from the tagged source range');
}

/** Admit only reviewed compatibility facts; source and published digest are joined by the producer. */
export function readReleaseAssessment(repoRoot, tag) {
  if (!parseVersionTag(tag).includes('-'))
    throw Error('Release Management: assessment requires a prerelease tag');
  const file = join(repoRoot, 'release-notes', `${tag}.manifest.json`);
  if (!lstatSync(file).isFile())
    throw Error('Release Management: assessment must be a regular reviewed file');
  const facts = JSON.parse(readFileSync(file, 'utf8'));
  noSecrets(facts);
  if (
    !hasExactKeys(facts, [
      'previousAppImageId',
      'migrationFree',
      'configurationCompatible',
      'retainedDataCompatible',
      'recovery',
      'provenance',
      ...(facts?.recovery === 'restore-pre-update-backup' ? ['forwardMigration'] : []),
    ]) ||
    !/^sha256:[a-f0-9]{64}$/u.test(facts.previousAppImageId ?? '') ||
    !admittedTransitionFacts(facts, tag) ||
    !/^[a-z0-9-]+$/u.test(facts.provenance ?? '')
  )
    throw Error(
      'Release Management: reviewed compatibility/recovery assessment is missing or unassessed'
    );
  return facts;
}

/**
 * Verifies that the portable release inputs exist and the bundled CLI remains executable.
 *
 * @param {string} repoRoot Repository root.
 */
function validatePortableReleaseInputs(repoRoot) {
  for (const path of [
    'LICENSE',
    'skills/openkit-ops/scripts/openkit',
    'skills/openkit-ops/SKILL.md',
  ]) {
    assertRelativeExistingPath(repoRoot, path, 'Portable release input');
  }
  if ((statSync(join(repoRoot, 'skills/openkit-ops/scripts/openkit')).mode & 0o111) === 0) {
    throw new Error(
      'Bundled administrator CLI must be executable: skills/openkit-ops/scripts/openkit'
    );
  }
}

/** Parses the supported OpenShell release and its external artifact identities. */
export function parseOpenShellRelease(source) {
  const release = JSON.parse(source);
  const sha256 = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
  const digest = (value) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
  const exactKeys = (value, keys) =>
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
  const targets = release?.gateway?.targets;
  const validGateway = (target, pin) => {
    const archive = pin?.archive;
    const executable = pin?.executable;
    return (
      exactKeys(pin, ['archive', 'executable']) &&
      exactKeys(archive, ['name', 'target', 'sha256']) &&
      archive.name === NANOHOST_TARGETS[target].gatewayArchive &&
      archive.target === target &&
      sha256(archive.sha256) &&
      exactKeys(executable, ['name', 'derivedFrom', 'sha256']) &&
      executable.name === 'openshell-gateway' &&
      executable.derivedFrom === archive.name &&
      sha256(executable.sha256)
    );
  };
  const license = release?.redistribution?.license;
  const notices = release?.redistribution?.notices;
  const platformDigests = release?.supervisor?.platformDigests;
  if (
    !exactKeys(release, [
      'schemaVersion',
      'version',
      'source',
      'gateway',
      'supervisor',
      'redistribution',
    ]) ||
    release.schemaVersion !== 2 ||
    typeof release.version !== 'string' ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(release.version) ||
    !exactKeys(release.source, ['commit']) ||
    typeof release.source.commit !== 'string' ||
    !/^[a-f0-9]{40}$/u.test(release.source.commit) ||
    !exactKeys(release.gateway, ['targets']) ||
    !exactKeys(targets, Object.keys(NANOHOST_TARGETS)) ||
    Object.keys(NANOHOST_TARGETS).some((target) => !validGateway(target, targets[target])) ||
    !exactKeys(release.supervisor, ['repository', 'platformDigests']) ||
    release.supervisor.repository !== 'ghcr.io/nvidia/openshell/supervisor' ||
    !exactKeys(platformDigests, ['linux/amd64', 'linux/arm64']) ||
    !digest(platformDigests['linux/amd64']) ||
    !digest(platformDigests['linux/arm64']) ||
    !exactKeys(release.redistribution, ['license', 'notices']) ||
    !exactKeys(license, ['sourcePath', 'bundlePath', 'sha256']) ||
    license.sourcePath !== 'LICENSE' ||
    license.bundlePath !== 'licenses/openshell-LICENSE' ||
    !sha256(license.sha256) ||
    !exactKeys(notices, ['sourcePath', 'bundlePath', 'sha256']) ||
    notices.sourcePath !== 'THIRD-PARTY-NOTICES' ||
    notices.bundlePath !== 'licenses/openshell-THIRD-PARTY-NOTICES' ||
    !sha256(notices.sha256)
  ) {
    throw new Error('OpenShell release metadata is invalid.');
  }
  return release;
}

/** Requires Cargo dependency and lockfile identities to match one OpenShell release. */
export function assertOpenShellSdkRevision(release, cargoToml, cargoLock) {
  const dependencyBlock = /openshell-sdk\s*=\s*\{([^}]*)\}/su.exec(cargoToml)?.[1];
  const dependencyRev = dependencyBlock
    ? /(?:^|,)\s*rev\s*=\s*"([a-f0-9]{40})"\s*(?:,|$)/u.exec(dependencyBlock)?.[1]
    : undefined;
  const officialDependency = dependencyBlock
    ? /(?:^|,)\s*git\s*=\s*"https:\/\/github\.com\/NVIDIA\/OpenShell\.git"\s*(?:,|$)/u.test(
        dependencyBlock
      )
    : false;
  const packages = cargoLock
    .split('[[package]]')
    .slice(1)
    .filter((block) => /^\s*name\s*=\s*"openshell-sdk"\s*$/mu.test(block));
  const lockedSource =
    packages.length === 1 ? /^source\s*=\s*"([^"]+)"\s*$/mu.exec(packages[0])?.[1] : undefined;
  const commit = release.source.commit;
  if (
    !officialDependency ||
    dependencyRev !== commit ||
    lockedSource !== `git+https://github.com/NVIDIA/OpenShell.git?rev=${commit}#${commit}`
  ) {
    throw new Error(
      'OpenShell release source commit must match the Cargo SDK revision and lockfile.'
    );
  }
}

/** Parses the schema-2 capability profile without admitting executable shell text or unknown core semantics. */
export function parseNanoHostHostManifest(source) {
  const manifest = JSON.parse(source);
  const classes = [
    'platform',
    'service-manager',
    'kernel',
    'executable',
    'version',
    'libc',
    'filesystem',
  ];
  const probes = [
    'platform',
    'systemd',
    'service-principal',
    'cgroup-v2',
    'namespaces',
    'seccomp',
    'executable',
    'docker-version',
    'git-version',
    'resolver',
    'libc',
    'ancestors',
  ];
  const ids = new Set();
  const validTimeout = (value) => Number.isFinite(value) && value > 0;
  const validId = (value) => typeof value === 'string' && /^[a-z][a-z0-9-]{0,127}$/.test(value);
  if (
    manifest.schemaVersion !== 2 ||
    !validId(manifest.profileId) ||
    !Array.isArray(manifest.architectures) ||
    manifest.architectures.length !== 2 ||
    new Set(manifest.architectures).size !== 2 ||
    manifest.architectures.some((value) => !['amd64', 'arm64'].includes(value)) ||
    !Array.isArray(manifest.requirements) ||
    manifest.requirements.length === 0 ||
    manifest.requirements.some((entry) => {
      if (
        !validId(entry.id) ||
        ids.has(entry.id) ||
        !classes.includes(entry.class) ||
        !probes.includes(entry.probe) ||
        !validTimeout(entry.timeoutSeconds) ||
        !entry.predicate ||
        Array.isArray(entry.predicate) ||
        typeof entry.predicate !== 'object'
      )
        return true;
      ids.add(entry.id);
      return !validNanoHostPredicate(entry);
    }) ||
    manifest.recommendation?.scope !== 'combined-small-deployment' ||
    !['availableLogicalCpus', 'availableMemoryBytes', 'availableStorageBytes'].every(
      (key) =>
        Number.isSafeInteger(manifest.recommendation[key]) && manifest.recommendation[key] > 0
    ) ||
    !validTimeout(manifest.recommendation.timeoutSeconds)
  )
    throw new Error('NanoHost host profile is invalid.');
  return manifest;
}

/** Checks the implemented predicate core; additive profile metadata carries no authority. */
function validNanoHostPredicate(entry) {
  const p = entry.predicate;
  const same = (value) =>
    Object.keys(p).length === Object.keys(value).length &&
    Object.entries(value).every(
      ([key, wanted]) => JSON.stringify(p[key]) === JSON.stringify(wanted)
    );
  switch (entry.probe) {
    case 'platform':
      return entry.class === 'platform' && same({ os: 'Linux' });
    case 'systemd':
      return (
        entry.class === 'service-manager' &&
        same({ active: true, unit: 'openkit-nanohost.service' })
      );
    case 'service-principal':
      return (
        entry.class === 'service-manager' &&
        same({ user: 'root', requiredCapabilities: ['CAP_SYS_ADMIN', 'CAP_NET_ADMIN'] })
      );
    case 'cgroup-v2':
      return entry.class === 'kernel' && same({ filesystem: 'cgroup2fs' });
    case 'namespaces':
      return entry.class === 'kernel' && same({ names: ['mnt', 'net'] });
    case 'seccomp':
      return entry.class === 'kernel' && same({ supported: true });
    case 'executable':
      return (
        entry.class === 'executable' &&
        [
          '/usr/bin/containerd',
          '/usr/bin/dockerd',
          '/usr/bin/docker',
          '/usr/bin/git',
          '/usr/bin/slirp4netns',
        ].includes(p.path) &&
        same({ path: p.path, regularNonSymlink: true, executable: true })
      );
    case 'docker-version':
      return entry.class === 'version' && same({ path: '/usr/bin/docker', minimum: '28.0' });
    case 'git-version':
      return entry.class === 'version' && same({ path: '/usr/bin/git', format: 'git-version' });
    case 'resolver':
      return (
        entry.class === 'filesystem' &&
        same({ path: '/run/systemd/resolve/resolv.conf', usableNameserver: true })
      );
    case 'libc':
      return (
        entry.class === 'libc' &&
        same({ executables: ['nanohost', 'openshell-gateway'], derive: 'elf-version-needs' })
      );
    case 'ancestors':
      return (
        entry.class === 'filesystem' &&
        same({
          paths: [
            '/usr/lib/openkit/nanohost',
            '/usr/lib/openkit/openshell-gateway',
            '/etc/systemd/system/openkit-nanohost.service',
            '/etc/openkit/nanohost.env',
            '/var/lib/openkit/nanohost',
            '/run/openkit/nanohost',
            '/var/lib/openkit/nanohost-images',
            '/var/lib/openkit/nanohost-work',
            '/var/lib/openkit/nanohost-workspace-scan',
          ],
          uid: 0,
          forbidMode: 18,
        })
      );
    default:
      return false;
  }
}

/** Validates the fixed NanoHost installer, unit, and OpenShell release inputs. */
function validateNanoHostReleaseInputs(repoRoot) {
  for (const path of [
    'apps/nanohost/deploy/install.sh',
    'apps/nanohost/deploy/openkit-nanohost.service',
    'apps/nanohost/deploy/host-manifest.json',
    'apps/nanohost/openshell/release.json',
    'apps/nanohost/Cargo.toml',
    'apps/nanohost/Cargo.lock',
  ]) {
    assertRelativeExistingPath(repoRoot, path, 'NanoHost release input');
  }
  const installer = join(repoRoot, 'apps/nanohost/deploy/install.sh');
  if ((statSync(installer).mode & 0o111) === 0) {
    throw new Error('NanoHost release installer must be executable.');
  }
  const unit = readFileSync(
    join(repoRoot, 'apps/nanohost/deploy/openkit-nanohost.service'),
    'utf8'
  );
  if (!unit.includes('ExecStart=/usr/lib/openkit/nanohost')) {
    throw new Error('NanoHost service unit must use the fixed NanoHost destination.');
  }
  parseNanoHostHostManifest(
    readFileSync(join(repoRoot, 'apps/nanohost/deploy/host-manifest.json'), 'utf8')
  );
  const release = parseOpenShellRelease(
    readFileSync(join(repoRoot, 'apps/nanohost/openshell/release.json'), 'utf8')
  );
  assertOpenShellSdkRevision(
    release,
    readFileSync(join(repoRoot, 'apps/nanohost/Cargo.toml'), 'utf8'),
    readFileSync(join(repoRoot, 'apps/nanohost/Cargo.lock'), 'utf8')
  );
}

/**
 * Validates the container image manifest and returns release image ids.
 *
 * @param {string} repoRoot Repository root.
 * @param {boolean} requireReleaseImageDigests Whether release images must be digest-pinned.
 * @returns {string[]} Release image ids.
 */
function validateImageManifest(repoRoot, requireReleaseImageDigests) {
  const manifest = readJson(join(repoRoot, 'containers', 'images.json'));

  if (manifest.schemaVersion !== 1) {
    throw new Error('containers/images.json must use schemaVersion 1.');
  }
  if (manifest.registry !== 'ghcr.io') {
    throw new Error('containers/images.json registry must be ghcr.io.');
  }
  if (!Array.isArray(manifest.images) || manifest.images.length === 0) {
    throw new Error('containers/images.json must declare at least one image.');
  }

  const ids = new Set();
  const workerTargets = new Set();
  const emptyDeclaredSetReleaseWorkers = [];
  const releaseImages = [];

  for (const image of manifest.images) {
    validateImageEntry(
      repoRoot,
      image,
      ids,
      workerTargets,
      emptyDeclaredSetReleaseWorkers,
      requireReleaseImageDigests
    );
    if (image.release === true) {
      releaseImages.push(image.id);
    }
  }

  if (emptyDeclaredSetReleaseWorkers.length !== 1) {
    throw new Error(
      'containers/images.json must declare exactly one public release worker base with an empty declared runtime set.'
    );
  }

  if (releaseImages.length === 0) {
    throw new Error('containers/images.json does not declare release images.');
  }

  return releaseImages;
}

/**
 * Validates one image manifest entry.
 *
 * A release worker base is identified by absent runtimes metadata rather than image id, and workerContract is required exactly when runtime metadata exists.
 *
 * @param {string} repoRoot Repository root.
 * @param {Record<string, unknown>} image Image entry.
 * @param {Set<string>} ids Seen image ids.
 * @param {Set<string>} workerTargets Seen worker Docker targets.
 * @param {string[]} emptyDeclaredSetReleaseWorkers Release worker ids whose declared runtime set is empty.
 * @param {boolean} requireReleaseImageDigests Whether release images must be digest-pinned.
 */
function validateImageEntry(
  repoRoot,
  image,
  ids,
  workerTargets,
  emptyDeclaredSetReleaseWorkers,
  requireReleaseImageDigests
) {
  for (const field of [
    'id',
    'repository',
    'dockerfile',
    'context',
    'kind',
    'release',
    'platforms',
    'smoke',
    'smokeCommand',
    'localTag',
  ]) {
    if (image[field] === undefined || image[field] === '') {
      throw new Error(`Image entry is missing ${field}.`);
    }
  }
  if (ids.has(image.id)) {
    throw new Error(`Duplicate image id: ${image.id}`);
  }
  ids.add(image.id);

  if (image.anonymousPull !== undefined && typeof image.anonymousPull !== 'boolean') {
    throw new Error(`Image ${image.id} anonymousPull must be a boolean when present.`);
  }

  if (!['app', 'worker', 'test'].includes(image.kind)) {
    throw new Error(`Image ${image.id} has invalid kind: ${image.kind}`);
  }
  if (!Array.isArray(image.platforms) || image.platforms.length === 0) {
    throw new Error(`Image ${image.id} must declare at least one platform.`);
  }
  assertRelativeExistingPath(repoRoot, image.dockerfile, `Image ${image.id} dockerfile`);
  assertRelativeExistingPath(repoRoot, image.smoke, `Image ${image.id} smoke`);

  if (image.release === true && requireReleaseImageDigests) {
    if (!/^.+@sha256:[a-f0-9]{64}$/.test(String(image.baseImage ?? ''))) {
      throw new Error(`Release image ${image.id} must use a digest-pinned baseImage.`);
    }
  }

  if (image.kind === 'worker') {
    for (const field of ['baseImage', 'target']) {
      if (!image[field]) {
        throw new Error(`Worker image ${image.id} is missing ${field}.`);
      }
    }
    if (image.target !== image.id) {
      throw new Error(`Worker image ${image.id} target must equal its image id.`);
    }
    if (workerTargets.has(image.target)) {
      throw new Error(`Duplicate worker image target: ${image.target}`);
    }
    workerTargets.add(image.target);

    if (
      Object.hasOwn(image, 'runtime') ||
      ['worker-codex', 'worker-opencode', 'worker-pi'].includes(image.id)
    ) {
      throw new Error(
        `Worker image ${image.id} uses retired leaf ids or singular runtime metadata.`
      );
    }
    const hasRuntime = Object.hasOwn(image, 'runtimes');
    const hasWorkerContract = Object.hasOwn(image, 'workerContract');
    if (
      hasRuntime &&
      (!Array.isArray(image.runtimes) ||
        image.runtimes.length === 0 ||
        image.runtimes.some(
          (runtime) => typeof runtime !== 'string' || runtime.trim().length === 0
        ) ||
        new Set(image.runtimes).size !== image.runtimes.length)
    ) {
      throw new Error(
        `Worker image ${image.id} runtimes must be a non-empty array of unique non-empty strings when present.`
      );
    }
    if (
      hasWorkerContract &&
      (typeof image.workerContract !== 'string' || image.workerContract.trim().length === 0)
    ) {
      throw new Error(
        `Worker image ${image.id} workerContract must be a non-empty string when present.`
      );
    }
    if (hasRuntime && !hasWorkerContract) {
      throw new Error(`Worker image ${image.id} is missing workerContract.`);
    }
    if (!hasRuntime && hasWorkerContract) {
      throw new Error(
        `Worker image ${image.id} is missing runtimes; workerContract is required exactly when runtime metadata exists.`
      );
    }
    if (!hasRuntime && image.release === true) {
      if (image.anonymousPull !== true) {
        throw new Error(`Public release worker base ${image.id} must declare anonymousPull: true.`);
      }
      emptyDeclaredSetReleaseWorkers.push(image.id);
    } else if (image.anonymousPull === true) {
      throw new Error(
        `Image ${image.id} may not declare anonymousPull: true; only the public release worker base may do so.`
      );
    }
  } else if (image.anonymousPull === true) {
    throw new Error(
      `Image ${image.id} may not declare anonymousPull: true; only the public release worker base may do so.`
    );
  }
}

/**
 * Verifies that a manifest path is relative, stays inside the repo, and exists.
 *
 * @param {string} repoRoot Repository root.
 * @param {unknown} value Path value.
 * @param {string} label Error label.
 */
function assertRelativeExistingPath(repoRoot, value, label) {
  if (typeof value !== 'string' || isAbsolute(value) || value.includes('..')) {
    throw new Error(`${label} must be a repository-relative path.`);
  }
  if (!existsSync(join(repoRoot, value))) {
    throw new Error(`${label} does not exist: ${value}`);
  }
}

/**
 * Verifies that the release commit is reachable from the main branch ref.
 *
 * @param {string} repoRoot Repository root.
 * @param {string | undefined} sha Commit sha.
 * @param {string} mainRef Main branch ref.
 */
function assertTagOnMain(repoRoot, sha, mainRef) {
  if (!sha) {
    throw new Error('Release preflight requires --sha when --require-main is set.');
  }
  const result = spawnSync('git', ['merge-base', '--is-ancestor', sha, mainRef], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`Release commit ${sha} is not contained in ${mainRef}.`);
  }
}

/**
 * Reads one JSON file.
 *
 * @param {string} path JSON path.
 * @returns {Record<string, unknown>} Parsed JSON object.
 */
function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Parses CLI flags.
 *
 * @param {string[]} argv CLI argv without node and script.
 * @returns {Record<string, string | boolean>} Parsed flags.
 */
function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      continue;
    }
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    if (key === 'require-main') {
      args[key] = true;
    } else {
      const value = argv[++index];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Missing value for --${key}.`);
      }
      args[key] = value;
    }
  }
  return args;
}

/**
 * Runs the preflight CLI.
 */
function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = validateReleasePreflight({
    mainRef: String(args['main-ref'] ?? 'origin/main'),
    repoRoot: String(args['repo-root'] ?? process.cwd()),
    requireMain: Boolean(args['require-main']),
    requirePrerelease: true,
    requireReleaseManifestAssessment: true,
    requireReleaseImageDigests: true,
    sha: args.sha ? String(args.sha) : undefined,
    tag: String(args.tag ?? process.env.GITHUB_REF_NAME ?? ''),
    promotionSourceTag: args['promotion-source'] ? String(args['promotion-source']) : undefined,
    repository: args.repository ? String(args.repository) : process.env.GITHUB_REPOSITORY,
    authorization: process.env.OPENKIT_STABLE_PROMOTION,
  });

  checkWorkflows({ repoRoot: String(args['repo-root'] ?? process.cwd()), all: true });
  console.log(`Release preflight passed for ${result.version}.`);
  if (result.promotionSourceTag) console.log(`Promotion source: ${result.promotionSourceTag}`);
  console.log(`Release images: ${result.releaseImages.join(', ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

/** Validates emitted checker evidence at its consumer boundary without recreating its comparator. */
export function parseNanoHostHostCheckResult(source, expected) {
  const result = JSON.parse(source);
  const keys = [
    'schemaVersion',
    'profileId',
    'profileDigest',
    'productCommit',
    'archiveSha256',
    'machineIdentityDigest',
    'machineObservationDigest',
    'checkedAt',
    'hardVerdict',
    'recommendationObservation',
    'requirements',
  ];
  const hex = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  if (
    source !== `${JSON.stringify(result)}\n` ||
    JSON.stringify(Object.keys(result)) !== JSON.stringify(keys) ||
    result.schemaVersion !== 2 ||
    result.profileId !== expected.profile.profileId ||
    result.profileDigest !== expected.profileDigest ||
    !/^[0-9a-f]{40}$/.test(result.productCommit) ||
    (expected.productCommit !== undefined && result.productCommit !== expected.productCommit) ||
    !hex(result.archiveSha256) ||
    !hex(result.machineIdentityDigest) ||
    !hex(result.machineObservationDigest) ||
    typeof result.checkedAt !== 'string' ||
    Number.isNaN(Date.parse(result.checkedAt)) ||
    !['requirements-met', 'requirements-unmet', 'cannot-check'].includes(result.hardVerdict) ||
    !['met', 'unmet', 'cannot-check'].includes(result.recommendationObservation) ||
    !Array.isArray(result.requirements) ||
    result.requirements.length !== expected.profile.requirements.length ||
    result.requirements.some(
      (item, index) =>
        JSON.stringify(Object.keys(item)) !== JSON.stringify(['id', 'outcome', 'observed']) ||
        item.id !== expected.profile.requirements[index].id ||
        !['met', 'unmet', 'cannot-check'].includes(item.outcome) ||
        (item.outcome === 'cannot-check'
          ? item.observed !== null
          : !item.observed || typeof item.observed !== 'object' || Array.isArray(item.observed))
    ) ||
    result.machineObservationDigest !==
      createHash('sha256').update(JSON.stringify(result.requirements)).digest('hex') ||
    (result.hardVerdict === 'requirements-met' &&
      result.requirements.some((item) => item.outcome !== 'met')) ||
    (result.hardVerdict === 'requirements-unmet' &&
      !result.requirements.some((item) => item.outcome === 'unmet'))
  )
    throw new Error('NanoHost host-check evidence is invalid or stale.');
  return result;
}
