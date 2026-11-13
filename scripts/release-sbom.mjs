#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { runOsv } from './security-scan.mjs';
import pins from './security-tools.json' with { type: 'json' };

/** Project exact native OSV inventory purls; never reconstruct an OS purl from an ecosystem label. */
export function bomFromOsv(report, { stripPrefix = '' } = {}) {
  if (!Array.isArray(report?.results)) throw Error('Native inventory missing');
  const components = new Map();
  for (const result of report.results) {
    if (!result.source || !Array.isArray(result.packages))
      throw Error('Malformed native inventory source');
    const raw = result.source.path;
    if (typeof raw !== 'string' || !raw || raw.includes('\0'))
      throw Error('Inventory location missing');
    let location = raw;
    if (stripPrefix) {
      if (!location.startsWith(`${stripPrefix}/`))
        throw Error('Inventory outside selected artifact');
      location = location.slice(stripPrefix.length);
    }
    for (const entry of result.packages) {
      const value = entry.package;
      if (
        !value ||
        typeof value.name !== 'string' ||
        !value.name ||
        typeof value.version !== 'string' ||
        !value.version ||
        typeof value.purl !== 'string' ||
        !/^pkg:[a-z][a-z0-9.+-]*\//u.test(value.purl)
      )
        throw Error('Incomplete native package identity');
      if (purlVersion(value.purl) !== value.version) throw Error('Native purl version mismatch');
      let component = components.get(value.purl);
      if (!component) {
        component = {
          type: 'library',
          'bom-ref': value.purl,
          name: value.os_package_name ?? value.name,
          version: value.version,
          purl: value.purl,
          evidence: { occurrences: [] },
        };
        components.set(value.purl, component);
      }
      if (!component.evidence.occurrences.some((item) => item.location === location))
        component.evidence.occurrences.push({ location });
    }
  }
  if (!components.size) throw Error('Selected artifact inventory is unexpectedly empty');
  const ordered = [...components.values()].sort((a, b) => a.purl.localeCompare(b.purl));
  for (const component of ordered)
    component.evidence.occurrences.sort((a, b) => a.location.localeCompare(b.location));
  return { bomFormat: 'CycloneDX', specVersion: '1.6', version: 1, components: ordered };
}

const sha256 = /^sha256:[a-f0-9]{64}$/u;
const platformPattern = /^linux\/(?:amd64|arm64)$/u;
function purlVersion(purl) {
  if (typeof purl !== 'string' || !/^pkg:[a-z][a-z0-9.+-]*\//u.test(purl))
    throw Error('Package URL required');
  const body = purl.split(/[?#]/u)[0];
  const at = body.lastIndexOf('@');
  const start = body.indexOf('/') + 1;
  if (
    at <= start ||
    at === body.length - 1 ||
    body
      .slice(start, at)
      .split('/')
      .some((segment) => !segment)
  )
    throw Error('Versioned package URL required');
  return decodeURIComponent(body.slice(at + 1));
}
export const APP_SBOM_PATH = '/app/security/sbom.cdx.json';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function run(command, args, env) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      env,
      timeout: 180000,
      maxBuffer: 128 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    throw Error('Release inventory operation failed');
  }
}
function toolEnvironment() {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    DOCKER_CONFIG: process.env.DOCKER_CONFIG,
  };
}
export function releaseImages() {
  return JSON.parse(
    readFileSync(new URL('../containers/images.json', import.meta.url), 'utf8')
  ).images.filter((image) => image.release === true);
}
export function sbomName(id, platform, tag) {
  if (
    !/^[a-z0-9-]+$/u.test(id) ||
    !platformPattern.test(platform) ||
    !/^v\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/u.test(tag)
  )
    throw Error('SBOM filename identity refused');
  return `openkit-sbom-${id}-${platform.replace('/', '-')}-${tag}.cdx.json`;
}
/** Existing catalog/platform subjects plus the two existing NanoHost archive targets. */
export function sbomAssetNames(tag) {
  return [
    ...releaseImages().flatMap((image) =>
      image.platforms.map((platform) => sbomName(image.id, platform, tag))
    ),
    ...['linux/amd64', 'linux/arm64'].map((platform) => sbomName('nanohost', platform, tag)),
  ].sort();
}
export function artifactSource(kind, id, platform) {
  if (
    !['image', 'archive'].includes(kind) ||
    !/^[a-z0-9-]+$/u.test(id) ||
    !platformPattern.test(platform)
  )
    throw Error('Artifact source identity refused');
  return `${kind}:${id}:${platform}`;
}
function bindBom(bom, { kind, id, platform, sha, reference }) {
  if (sha !== undefined && !/^[a-f0-9]{40}$/u.test(sha)) throw Error('SBOM source commit refused');
  bom.metadata = {
    ...bom.metadata,
    tools: bom.metadata?.tools ?? {
      components: [
        { type: 'application', name: 'osv-scanner', version: pins['osv-scanner'].version },
      ],
    },
    properties: [
      ...(bom.metadata?.properties ?? []),
      { name: 'openkit:artifact-source', value: artifactSource(kind, id, platform) },
      { name: 'openkit:platform', value: platform },
      ...(sha ? [{ name: 'openkit:source-commit', value: sha }] : []),
      ...(reference ? [{ name: 'openkit:artifact-reference', value: reference }] : []),
    ],
  };
  return bom;
}
/** Reviewed opaque vendor bytes are version-searchable, never transitive completeness evidence. */
export function addOpaqueGateway(bom, { release, platform }) {
  const target = release?.gateway?.targets?.[platform];
  if (
    release?.schemaVersion !== 2 ||
    release.version !== '0.0.99' ||
    !platformPattern.test(platform) ||
    !sha256.test(`sha256:${target?.archive?.sha256}`) ||
    !sha256.test(`sha256:${target?.executable?.sha256}`) ||
    !Array.isArray(bom?.components)
  )
    throw Error('Reviewed opaque Gateway identity required');
  const purl = `pkg:github/nvidia/openshell@${release.version}?arch=${platform.split('/')[1]}`;
  if (bom.components.some((component) => component.purl === purl))
    throw Error('Opaque Gateway repeated');
  const component = {
    type: 'application',
    name: 'openshell-gateway',
    version: release.version,
    purl,
    'bom-ref': purl,
    supplier: { name: 'NVIDIA' },
    hashes: [{ alg: 'SHA-256', content: target.executable.sha256 }],
    externalReferences: [
      {
        type: 'distribution',
        url: `https://github.com/NVIDIA/OpenShell/releases/download/v${release.version}/${target.archive.name}`,
        hashes: [{ alg: 'SHA-256', content: target.archive.sha256 }],
      },
    ],
    properties: [
      { name: 'openkit:transitive-coverage', value: 'unknown' },
      { name: 'openkit:vulnerability-lookup', value: 'component-version-only' },
      { name: 'openkit:clearance-authority', value: 'none' },
      { name: 'openkit:purge-authority', value: 'none' },
    ],
  };
  return {
    ...bom,
    components: [...bom.components, component],
    compositions: [...(bom.compositions ?? []), { aggregate: 'unknown', assemblies: [purl] }],
  };
}
/** Refuse unsupported/empty or mismatched producer coordinates, never silently omit a package. */
export function assertSbom(bom, { kind, id, platform, sha, reference }) {
  if (
    bom?.bomFormat !== 'CycloneDX' ||
    bom.specVersion !== '1.6' ||
    !Array.isArray(bom.components) ||
    !bom.components.length
  )
    throw Error('SBOM inventory unavailable');
  const properties = bom.metadata?.properties;
  if (!Array.isArray(properties)) throw Error('SBOM binding missing');
  const value = (name) => {
    const values = properties.filter((property) => property.name === name);
    if (values.length !== 1 || typeof values[0].value !== 'string')
      throw Error('SBOM binding repeated or missing');
    return values[0].value;
  };
  if (
    value('openkit:artifact-source') !== artifactSource(kind, id, platform) ||
    value('openkit:platform') !== platform ||
    value('openkit:source-commit') !== sha ||
    (reference !== undefined && value('openkit:artifact-reference') !== reference)
  )
    throw Error('SBOM source binding mismatch');
  // Standard CDX file/distro descriptors are not installed software-package coordinates.
  const packages = bom.components.filter(
    (component) => !['file', 'operating-system'].includes(component?.type)
  );
  const seen = new Set();
  for (const component of packages) {
    const purl = component?.purl;
    const componentRef = component?.['bom-ref'];
    if (
      typeof purl !== 'string' ||
      !/^pkg:[a-z][a-z0-9.+-]*\//u.test(purl) ||
      (componentRef !== undefined &&
        (typeof componentRef !== 'string' || !componentRef || seen.has(componentRef))) ||
      typeof component.version !== 'string' ||
      !component.version ||
      component.version === 'UNKNOWN' ||
      purlVersion(purl) !==
        (purl.startsWith('pkg:golang/stdlib@') && /^go\d/u.test(component.version)
          ? component.version.slice(2)
          : component.version)
    )
      throw Error('SBOM package identity refused');
    if (componentRef !== undefined) seen.add(componentRef);
  }
  if (
    kind === 'image' &&
    (!packages.some((component) => component.purl.startsWith('pkg:deb/')) ||
      !packages.some((component) => component.purl.startsWith('pkg:npm/')))
  )
    throw Error('Image SBOM omitted installed Node or OS inventory');
  if (kind === 'archive') {
    const opaque = bom.components.filter((component) => component.name === 'openshell-gateway');
    if (
      !packages.some((component) => component.purl.startsWith('pkg:cargo/')) ||
      opaque.length !== 1 ||
      !bom.compositions?.some(
        (composition) =>
          composition.aggregate === 'unknown' &&
          composition.assemblies?.includes(opaque[0]['bom-ref'])
      )
    )
      throw Error('NanoHost SBOM omitted Rust or explicit opaque Gateway coverage');
    for (const [name, expected] of Object.entries({
      'openkit:transitive-coverage': 'unknown',
      'openkit:vulnerability-lookup': 'component-version-only',
      'openkit:clearance-authority': 'none',
      'openkit:purge-authority': 'none',
    })) {
      const values = opaque[0].properties?.filter((property) => property.name === name);
      if (values?.length !== 1 || values[0].value !== expected)
        throw Error('Opaque Gateway coverage authority refused');
    }
  }
  return bom;
}
function nativeInventory(args, { cwd, env = toolEnvironment() }) {
  const temporary = mkdtempSync(join(tmpdir(), 'openkit-sbom-config-'));
  try {
    const config = join(temporary, 'scanner.toml');
    writeFileSync(config, '', { flag: 'wx' });
    return runOsv(
      [
        ...args,
        '--offline',
        '--x-disable-plugins',
        'vulns',
        '--all-packages',
        '--format',
        'json',
        '--config',
        config,
      ],
      { cwd, env }
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
/** Native JS export package.json files belong to their versioned parent, not a second installation. */
export function normalizeRuntimeDescriptors(bom) {
  const javascript = (component) =>
    component.properties?.some(
      (property) =>
        property.name === 'syft:package:foundBy' &&
        property.value === 'javascript-package-cataloger'
    );
  const locations = (component) =>
    (component.properties ?? [])
      .filter(
        (property) =>
          /^syft:location:\d+:path$/u.test(property.name) && typeof property.value === 'string'
      )
      .map((property) => property.value)
      .filter(
        (path) =>
          path.startsWith('/') &&
          path.endsWith('/package.json') &&
          !path.includes('\0') &&
          !path.split('/').some((part) => part === '.' || part === '..')
      );
  const versioned = (component) => {
    try {
      return (
        typeof component.version === 'string' &&
        component.version !== 'UNKNOWN' &&
        purlVersion(component.purl) === component.version
      );
    } catch {
      return false;
    }
  };
  const parents = bom.components
    .filter((component) => javascript(component) && versioned(component))
    .flatMap((component) =>
      locations(component).map((path) => ({
        directory: path.slice(0, -'/package.json'.length),
        purl: component.purl,
      }))
    )
    .sort((a, b) => b.directory.length - a.directory.length);
  return {
    ...bom,
    components: bom.components.map((component) => {
      if (!javascript(component) || versioned(component)) return component;
      const paths = locations(component);
      if (!paths.length) return component;
      const owners = paths.map((path) =>
        parents.find((parent) => {
          if (!path.startsWith(`${parent.directory}/`)) return false;
          const relative = path.slice(parent.directory.length + 1);
          return relative !== 'package.json' && !relative.split('/').includes('node_modules');
        })
      );
      if (owners.some((owner) => !owner)) return component; // An unknown installed root remains a refusal.
      return {
        ...component,
        type: 'file',
        properties: [
          ...(component.properties ?? []),
          ...[...new Set(owners.map((owner) => owner.purl))].map((value) => ({
            name: 'openkit:package-descriptor-of',
            value,
          })),
        ],
      };
    }),
  };
}
/** Rootfs mount contains only the selected runtime; the scanner and output are outside that mount. */
export function rootfsBom({ root, id, platform, sha }) {
  const directory = resolve(root);
  const env = { ...toolEnvironment(), SYFT_CHECK_FOR_APP_UPDATE: 'false', SYFT_PARALLELISM: '2' };
  const version = run('syft', ['version'], env);
  if (!version.split('\n').some((line) => line.trim() === `Version:       ${pins.syft.version}`))
    throw Error('Pinned Syft version required');
  const bom = JSON.parse(
    run(
      'syft',
      [
        'scan',
        `dir:${directory}`,
        '--override-default-catalogers',
        'image',
        // PE helpers bundled by pnpm cannot execute on the selected Linux runtime.
        '--select-catalogers=-pe-binary-package-cataloger',
        '-o',
        'cyclonedx-json@1.6',
        '--quiet',
      ],
      env
    )
  );
  return bindBom(normalizeRuntimeDescriptors(bom), {
    kind: 'image',
    id,
    platform,
    sha,
  });
}
function embeddedAppBom(image, digest, platform) {
  const temporary = mkdtempSync(join(tmpdir(), 'openkit-embedded-sbom-'));
  let container;
  try {
    container = run('docker', [
      'create',
      '--platform',
      platform,
      '--entrypoint',
      '/bin/true',
      `${image}@${digest}`,
    ]);
    if (!/^[a-f0-9]{64}$/u.test(container)) throw Error('SBOM container identity refused');
    const file = join(temporary, 'sbom.cdx.json');
    run('docker', ['cp', `${container}:${APP_SBOM_PATH}`, file]);
    return readFileSync(file);
  } finally {
    if (container) run('docker', ['rm', container]);
    rmSync(temporary, { recursive: true, force: true });
  }
}
function imageBom(image, digest, identity) {
  // A fresh publisher must resolve the exact admitted platform before offline inventory.
  run('docker', ['pull', '--platform', identity.platform, `${image}@${digest}`]);
  const report = nativeInventory(
    ['scan', 'image', '--x-no-default-plugins', '--x-plugins', 'artifact', `${image}@${digest}`],
    { cwd: process.cwd() }
  );
  return bindBom(bomFromOsv(report), {
    ...identity,
    kind: 'image',
    reference: `${image}@${digest}`,
  });
}
/** Produce eight checksum-bound SBOM attachments from the selected published image/archive subjects. */
export async function generateReleaseSboms({
  repoRoot = process.cwd(),
  recordsDir,
  assetsDir,
  repository,
  tag,
  sha,
}) {
  const { imageIdentity, verifyIndex } = await import('./release-candidate.mjs');
  const { verifyNanoHostRelease } = await import('./verify-nanohost-release.mjs');
  const { indexPlatforms } = await import('./release-security.mjs');
  const { parseVersionTag } = await import('./release-preflight.mjs');
  parseVersionTag(tag);
  if (
    !/^[a-f0-9]{40}$/u.test(sha ?? '') ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? '')
  )
    throw Error('Release source identity refused');
  const catalog = releaseImages();
  const records = readdirSync(recordsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(recordsDir, name), 'utf8')));
  if (
    records.length !== catalog.length ||
    new Set(records.map((record) => record.id)).size !== catalog.length
  )
    throw Error('Complete released image inventory required');
  const created = run('git', ['show', '-s', '--format=%cI', sha]);
  for (const image of catalog) {
    const record = records.find((row) => row.id === image.id);
    const coordinate = imageIdentity({ repository, sha, tag, created, image }).image;
    if (!record || record.image !== coordinate || !sha256.test(record.digest ?? ''))
      throw Error('Released image binding refused');
    const index = JSON.parse(
      run('docker', ['buildx', 'imagetools', 'inspect', '--raw', `${coordinate}@${record.digest}`])
    );
    indexPlatforms(index, image.platforms);
    verifyIndex(record, index);
    for (const entry of record.platforms) {
      const identity = { kind: 'image', id: image.id, platform: entry.platform, sha };
      const bytes =
        image.id === 'app'
          ? embeddedAppBom(coordinate, entry.digest, entry.platform)
          : Buffer.from(
              `${JSON.stringify(imageBom(coordinate, entry.digest, identity), null, 2)}\n`
            );
      assertSbom(JSON.parse(bytes), {
        ...identity,
        ...(image.id === 'app' ? {} : { reference: `${coordinate}@${entry.digest}` }),
      });
      writeFileSync(join(assetsDir, sbomName(image.id, entry.platform, tag)), bytes, {
        flag: 'wx',
      });
    }
  }
  for (const architecture of ['amd64', 'arm64']) {
    const platform = `linux/${architecture}`;
    const archive = join(assetsDir, `openkit-nanohost-${tag}-linux-${architecture}.tar.gz`);
    const temporary = mkdtempSync(join(tmpdir(), 'openkit-nanohost-sbom-'));
    try {
      const destdir = join(temporary, 'staged');
      verifyNanoHostRelease({
        archive,
        checksumFile: join(assetsDir, 'SHA256SUMS'),
        destdir,
        repoRoot,
      });
      const report = nativeInventory(
        [
          'scan',
          'source',
          '--recursive',
          '--x-no-default-plugins',
          '--x-plugins',
          'artifact',
          destdir,
        ],
        { cwd: destdir }
      );
      const identity = {
        kind: 'archive',
        id: 'nanohost',
        platform,
        sha,
        reference: `sha256:${hash(readFileSync(archive))}`,
      };
      const release = JSON.parse(
        readFileSync(join(repoRoot, 'apps/nanohost/openshell/release.json'), 'utf8')
      );
      const bom = bindBom(
        addOpaqueGateway(bomFromOsv(report, { stripPrefix: destdir }), { release, platform }),
        identity
      );
      assertSbom(bom, identity);
      writeFileSync(
        join(assetsDir, sbomName('nanohost', platform, tag)),
        `${JSON.stringify(bom, null, 2)}\n`,
        { flag: 'wx' }
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  // Reuse the existing image-record Markdown input; do not rewrite the reviewed notes renderer.
  appendFileSync(
    join(recordsDir, 'app.md'),
    '\n- OpenShell Gateway 0.0.99 is an opaque vendor component: CycloneDX composition is unknown; vulnerability lookup is component-version-only. Its transitive coverage grants no completeness, clearance or purge authority. Upstream SBOM/provenance: https://github.com/lingkaix/openkit/issues/719.\n'
  );
  const sumFile = join(assetsDir, 'SHA256SUMS');
  const existing = readFileSync(sumFile, 'utf8').trimEnd();
  const entries = sbomAssetNames(tag).map(
    (name) => `${hash(readFileSync(join(assetsDir, name)))}  ${name}`
  );
  writeFileSync(sumFile, `${existing}\n${entries.join('\n')}\n`);
}
/** One standard checksum primitive for immutable OCI subjects and every controlled file. */
export function provenanceSubjects({ manifest, assetsDir }) {
  if (
    !manifest ||
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.images) ||
    !Array.isArray(manifest.assets)
  )
    throw Error('Published subject inventory required');
  const names = [
    ...manifest.assets.map((asset) => asset.name),
    `openkit-release-${manifest.tag}.json`,
    'SHA256SUMS',
  ];
  if (new Set(names).size !== names.length || names.some((name) => basename(name) !== name))
    throw Error('Controlled attachment names required');
  const rows = names.map((name) => `${hash(readFileSync(join(assetsDir, name)))}  ${name}`);
  for (const image of manifest.images) {
    if (
      !/^ghcr\.io\/[a-z0-9._/-]+$/u.test(image.image) ||
      !sha256.test(image.digest) ||
      !Array.isArray(image.platforms) ||
      image.platforms.length !== 2
    )
      throw Error('Exact OCI subject set required');
    for (const digest of [image.digest, ...image.platforms.map((entry) => entry.digest)]) {
      if (!sha256.test(digest)) throw Error('OCI subject digest required');
      rows.push(`${digest.slice(7)}  ${image.image}@${digest}`);
    }
  }
  return `${rows.sort().join('\n')}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const mode = process.argv[2];
    const { values } = parseArgs({
      args: process.argv.slice(3),
      options: {
        root: { type: 'string' },
        id: { type: 'string' },
        platform: { type: 'string' },
        sha: { type: 'string' },
        repository: { type: 'string' },
        tag: { type: 'string' },
        records: { type: 'string' },
        assets: { type: 'string' },
        output: { type: 'string' },
      },
    });
    if (mode === 'rootfs') {
      const bom = rootfsBom(values);
      mkdirSync(resolve(values.output, '..'), { recursive: true });
      writeFileSync(values.output, `${JSON.stringify(bom, null, 2)}\n`, { flag: 'wx' });
    } else if (mode === 'release')
      await generateReleaseSboms({
        recordsDir: resolve(values.records),
        assetsDir: resolve(values.assets),
        repository: values.repository,
        tag: values.tag,
        sha: values.sha,
      });
    else if (mode === 'subjects') {
      const { publishedImages } = await import('./release-security.mjs');
      const assetsDir = resolve(values.assets);
      const manifest = publishedImages({
        directory: assetsDir,
        repoRoot: process.cwd(),
        repository: values.repository,
        sha: values.sha,
      });
      writeFileSync(values.output, provenanceSubjects({ manifest, assetsDir }), { flag: 'wx' });
    } else throw Error('Select rootfs, release or subjects mode');
  } catch {
    console.error('Release SBOM generation refused; no private input was printed');
    process.exitCode = 1;
  }
}
