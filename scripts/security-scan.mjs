/** Normalize the pinned OSV JSON boundary; retain no advisory prose or reachability analysis. */
import { spawnSync } from 'node:child_process';
import { posix } from 'node:path';
import pins from './security-tools.json' with { type: 'json' };

function refuse() {
  throw Error('Security scanner returned an invalid observation');
}
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse();
  return value;
}
function text(value) {
  if (typeof value !== 'string' || !value.trim()) refuse();
  return value;
}
function strings(value) {
  if (!Array.isArray(value)) refuse();
  return [...new Set(value.map(text))].sort();
}
function digest(value) {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) refuse();
  return value;
}

/** Parse structured CISA KEV ids, never derive exploitation from advisory prose. */
export function kevIds(catalog) {
  object(catalog);
  // The producer's catalogVersion is an opaque identity (currently dotted), not an ISO date.
  text(catalog.catalogVersion);
  if (!Array.isArray(catalog.vulnerabilities)) refuse();
  const result = new Set();
  for (const row of catalog.vulnerabilities) {
    object(row);
    if (!/^CVE-\d{4}-\d{4,}$/u.test(row.cveID)) refuse();
    result.add(row.cveID);
  }
  return result;
}

/**
 * One OSV source observation. Caller supplies its exact artifact and logical location,
 * not the scanner's temporary host path. max_severity is the pinned tool's numeric CVSS
 * result; no second CVSS implementation is maintained here. Unrated matches are H.
 */
export function findingsFromOsvSource(source, { artifact, location, knownCves }) {
  object(source);
  digest(artifact);
  text(location);
  if (!(knownCves instanceof Set) || !Array.isArray(source.packages)) refuse();
  const findings = [];
  for (const entry of source.packages) {
    object(entry);
    const pkg = object(entry.package);
    text(pkg.name);
    text(pkg.version);
    const purl = text(pkg.purl);
    if (!purl.startsWith('pkg:') || !purl.includes('@')) refuse();
    const vulnerabilities = entry.vulnerabilities ?? [];
    const groups = entry.groups ?? [];
    if (!Array.isArray(vulnerabilities) || !Array.isArray(groups)) refuse();
    const byId = new Map();
    for (const vuln of vulnerabilities) {
      object(vuln);
      text(vuln.id);
      byId.set(vuln.id, vuln);
    }
    const covered = new Set();
    for (const group of groups) {
      object(group);
      const ids = strings(group.ids);
      if (!ids.length || ids.some((id) => !byId.has(id))) refuse();
      const aliases = strings(group.aliases ?? []);
      const advisoryIds = [...new Set([...ids, ...aliases])].sort();
      const scoreText = group.max_severity;
      let score;
      if (scoreText !== undefined && scoreText !== '') {
        if (typeof scoreText !== 'string' || !/^(?:10(?:\.0+)?|[0-9](?:\.\d+)?)$/u.test(scoreText))
          refuse();
        score = Number(scoreText);
      }
      const knownExploited = advisoryIds.some((id) => knownCves.has(id) || id.startsWith('MAL-'));
      const cls = knownExploited
        ? 'K'
        : score === undefined
          ? 'H'
          : score >= 9
            ? 'C'
            : score >= 7
              ? 'H'
              : 'N';
      let fixAvailable = false;
      for (const id of ids) {
        covered.add(id);
        const vuln = byId.get(id);
        if (!Array.isArray(vuln.affected)) refuse();
        for (const affected of vuln.affected) {
          if (affected.package?.name !== pkg.name || affected.package?.ecosystem !== pkg.ecosystem)
            continue;
          for (const range of affected.ranges ?? []) {
            if (!Array.isArray(range.events)) refuse();
            if (
              range.events.some(
                (event) => typeof event.fixed === 'string' && event.fixed.length > 0
              )
            )
              fixAvailable = true;
          }
        }
      }
      findings.push({
        id: ids[0],
        artifact,
        component: { purl, location },
        advisoryIds,
        class: cls,
        knownExploited,
        fixAvailable,
      });
    }
    if (vulnerabilities.some((vuln) => !covered.has(vuln.id))) refuse();
  }
  return findings;
}

/** Only the committed tool version and its two documented result statuses carry findings. */
export function runOsv(args, { cwd, env }) {
  const version = spawnSync('osv-scanner', ['--version'], {
    env,
    encoding: 'utf8',
    timeout: 10000,
  });
  if (
    version.status !== 0 ||
    version.stdout.split('\n')[0].trim() !== `osv-scanner version: ${pins['osv-scanner'].version}`
  )
    throw Error('Pinned OSV scanner is required');
  const scanned = spawnSync('osv-scanner', args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (scanned.error || ![0, 1].includes(scanned.status))
    throw Error('Security scan could not complete');
  const report = JSON.parse(scanned.stdout);
  object(report);
  if (!Array.isArray(report.results)) refuse();
  return report;
}

/** Scan a platform manifest, never a mutable image tag, including its operating-system packages. */
export function scanImage({ image, platform, knownCves, cwd, env, config }) {
  if (!/^[^@\s]+@sha256:[a-f0-9]{64}$/u.test(image) || !/^linux\/(?:amd64|arm64)$/u.test(platform))
    refuse();
  const report = runOsv(
    ['scan', 'image', image, '--format', 'json', '--all-packages', '--config', config],
    { cwd, env }
  );
  const findings = [];
  let packages = 0;
  let os = false;
  for (const source of report.results) {
    object(source.source);
    const path = text(source.source.path);
    if (
      !['artifact', 'os'].includes(source.source.type) ||
      !path.startsWith('/') ||
      posix.normalize(path) !== path ||
      path.includes('\0')
    )
      refuse();
    if (source.source.type === 'os') os = true;
    if (!Array.isArray(source.packages)) refuse();
    packages += source.packages.length;
    findings.push(
      ...findingsFromOsvSource(source, {
        artifact: image.split('@')[1],
        location: `${platform}:${path.slice(1)}`,
        knownCves,
      })
    );
  }
  if (!os || !packages) throw Error('Image scan omitted its operating-system inventory');
  return findings;
}

/** New K/C/H matches fail a change; an unchanged match is reported without blocking it. */
export function newSevereFindings(before, after) {
  const key = (finding) =>
    JSON.stringify([
      finding.component.purl,
      finding.component.location,
      [...finding.advisoryIds].sort(),
    ]);
  const severe = (finding) => ['K', 'C', 'H'].includes(finding.class);
  const existing = new Set(before.filter(severe).map(key));
  return after.filter((finding) => severe(finding) && !existing.has(key(finding)));
}
