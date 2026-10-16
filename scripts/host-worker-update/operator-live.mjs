/** Concrete private-file, registry and fixed external-host adapters for component updates. */
import { randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NanoHostRuntimeTargetStatusResponseSchema } from '@openkit/app-api-schemas';
import { parseTree } from 'jsonc-parser';
import { z } from 'zod';
import { canonical, noSecrets, sha } from '../release-safety.mjs';
import { runBoundedProcess } from './bounded-process.mjs';
import { admitArchiveAttribution } from './host-observation.mjs';
import { createOperatorApi } from './operator-api.mjs';
import { createOperatorTransport } from './operator-transport.mjs';
import { admitComponentParameters } from './update-components.mjs';
import { admitNanoHostReleasePair } from './update-nanohost.mjs';

const unavailable =
  'Operator live input or observation unavailable; inspect before any new effect.';
const reasons = new Set([
  'request',
  'machine-binding',
  'runtime-directory',
  'verified-archive',
  'retained-inputs',
  'canonical-systemd-posture',
  'target-host-check',
  'maintenance-inhibition',
  'old-payload-custody',
  'target-installation',
  'controlled-start',
  'controlled-inspection',
  'supervision-restoration',
  'native-inspection',
]);

/** Preserve only finite local prerequisite names from the actual fixed root procedure. */
class OperatorStepUnavailable extends Error {
  constructor(reason) {
    super(`Operator step unavailable: ${reason}; inspect retained custody before any new effect.`);
    this.code = 'operator-step-unavailable';
    this.operatorReason = reason;
  }
}
const identityGuidance = Object.freeze({
  'machine-binding': 'Verify the retained physical host binding.',
  'app-helper-identity':
    'Install the selected checksum-pinned App helper and its protected configuration.',
  'canonical-docker-posture': 'Restore the supported canonical Docker deployment posture.',
  'app-web-attribution': 'Inspect the successful App receipt and its current Web payload.',
});

/** Retain only a local prerequisite category; remote text is never an error message. */
class OperatorIdentityUnavailable extends Error {
  constructor(reason) {
    super(`Operator identity unavailable. ${identityGuidance[reason]}`);
    this.code = 'operator-identity-unavailable';
    this.operatorReason = reason;
  }
}
const maxArchive = 536_870_912;
const sourceNames = [
  'host-procedure.py',
  'nanohost-maintenance.py',
  'nanohost-systemd.py',
  'nanohost-replacement.py',
];
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const imageDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const location = z
  .string()
  .refine((value) => path.isAbsolute(value) && path.normalize(value) === value);
const artifact = z.strictObject({
  archive: location,
  checksumFile: location,
  repoRoot: location,
  tag: z.string(),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  platform: z.enum(['linux/amd64', 'linux/arm64']),
  archiveSha256: hex,
});
const artifacts = z.strictObject({ old: artifact, target: artifact });
const bindingSchema = z.object({
  reference: z.string().min(1).max(128),
  sshAlias: z.literal('a1'),
  origin: z.string(),
  container: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/),
  machineId: z.string().regex(/^[a-f0-9]{32}$/),
  machineIdentityDigest: hex,
});
const stamp = z.strictObject({
  bootId: z.string().uuid(),
  pid: z.number().int().positive().max(2_147_483_647),
  startTimeTicks: z
    .string()
    .regex(/^[1-9][0-9]{0,19}$/)
    .refine((value) => BigInt(value) <= 18_446_744_073_709_551_615n),
});
const archiveVerifier = `try {const {attributeNanoHostArchive}=await import(${JSON.stringify(new URL('host-observation.mjs', import.meta.url).href)});const chunks=[];let size=0;for await(const chunk of process.stdin){size+=chunk.length;if(size>1048576)throw Error();chunks.push(chunk);}const input=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size));process.stdout.write(JSON.stringify(attributeNanoHostArchive(JSON.parse(input))));}catch{process.stderr.write('Archive verification unavailable.');process.exitCode=1;}`;

/** Refuse using local fixed text; no file path, provider text or root exception escapes. */
function need(condition) {
  if (!condition) throw Error(unavailable);
}

/** Strip inert observations or reject unsupported authority with a fixed diagnostic. */
function admit(schema, value) {
  const result = schema.safeParse(value);
  need(result.success);
  return result.data;
}

/** Decode exactly one JSON value and reject duplicate keys at every depth. */
function json(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const parsed = JSON.parse(text);
  const visit = (node) => {
    need(node);
    if (node.type === 'object') {
      const keys = node.children.map((child) => child.children[0].value);
      need(new Set(keys).size === keys.length);
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(parseTree(text));
  return parsed;
}

/** Exact stat identity includes nanosecond timestamps instead of rounded display values. */
function identity(info) {
  return ['dev', 'ino', 'mode', 'uid', 'gid', 'size', 'mtimeNs', 'ctimeNs']
    .map((key) => String(info[key]))
    .join(':');
}

/** Hold every safe ancestor open; Linux descriptor paths preserve non-following traversal. */
async function parentHandles(filename) {
  need(
    typeof filename === 'string' &&
      path.isAbsolute(filename) &&
      path.normalize(filename) === filename
  );
  const handles = [];
  const links = [];
  const uid = BigInt(process.getuid());
  try {
    let handle = await fs.open(
      '/',
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    handles.push(handle);
    for (const component of path.dirname(filename).split('/').filter(Boolean)) {
      const name = `/proc/self/fd/${handle.fd}/${component}`;
      handle = await fs.open(
        name,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      );
      handles.push(handle);
      const info = await handle.stat({ bigint: true });
      need(
        info.isDirectory() && (info.uid === 0n || info.uid === uid) && (info.mode & 0o022n) === 0n
      );
      links.push({ name, handle, identity: identity(info) });
    }
    return { handles, links, filename: `/proc/self/fd/${handle.fd}/${path.basename(filename)}` };
  } catch {
    for (const handle of handles.reverse()) await handle.close().catch(() => {});
    throw Error(unavailable);
  }
}

/** Read stable bounded bytes without following any file or ancestor link. */
async function readFile(filename, { limit, privateFile = false } = {}) {
  const parents = await parentHandles(filename);
  let file;
  try {
    file = await fs.open(
      parents.filename,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    const before = await file.stat({ bigint: true });
    need(
      before.isFile() &&
        before.uid === BigInt(process.getuid()) &&
        before.nlink === 1n &&
        before.size <= BigInt(limit) &&
        (privateFile ? (before.mode & 0o777n) === 0o600n : (before.mode & 0o022n) === 0n)
    );
    const chunks = [];
    let total = 0;
    while (total <= limit) {
      const buffer = Buffer.allocUnsafe(Math.min(65_536, limit + 1 - total));
      const { bytesRead } = await file.read(buffer);
      if (!bytesRead) break;
      total += bytesRead;
      need(total <= limit);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    need(
      identity(before) === identity(await file.stat({ bigint: true })) &&
        identity(before) === identity(await fs.lstat(parents.filename, { bigint: true }))
    );
    for (const link of parents.links)
      need(
        link.identity === identity(await link.handle.stat({ bigint: true })) &&
          link.identity === identity(await fs.lstat(link.name, { bigint: true }))
      );
    return Buffer.concat(chunks, total);
  } catch {
    throw Error(unavailable);
  } finally {
    await file?.close().catch(() => {});
    for (const handle of parents.handles.reverse()) await handle.close().catch(() => {});
  }
}

/**
 * Read an existing private authority file afresh with complete framing and stable metadata.
 * @param {string} filename Explicit absolute protected file, never a credential source.
 * @returns {Promise<object>} Parsed JSON with duplicate keys refused.
 */
export async function readOperatorJson(filename) {
  try {
    return json(await readFile(filename, { limit: 1_048_576, privateFile: true }));
  } catch {
    throw Error(unavailable);
  }
}

/** Fixed SSH options preserve the user's existing operator identity and host-key custody. */
function sshArguments(command) {
  return [
    '-T',
    '-x',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'ForwardAgent=no',
    '-o',
    'ClearAllForwardings=yes',
    '-o',
    'ConnectTimeout=10',
    '--',
    'a1',
    command,
  ];
}

/** Quote only this checkout's fixed root entry; no parameter is inserted into shell code. */
function shellQuote(source) {
  return `'${source.replaceAll("'", "'\"'\"'")}'`;
}

/** Admit the exact current private source selection; file paths never enter component evidence. */
async function selectedArtifacts(filename) {
  return admit(artifacts, await readOperatorJson(filename));
}

/**
 * Build actual adapters while keeping authentication with the existing administrator credential owner.
 *
 * Web tree content is measured against the successful helper receipt; webDigest is then release/platform attribution, not the tree's content hash.
 *
 * The fixed target child manifest supplies its image config digest; Docker image IDs never infer platform or release identity.
 * @param {string} target Explicit HTTPS staging origin.
 * @param {object} options Closed params and explicit deployment, grant, artifact and new private work locations.
 * @param {object} adapters Optional in-process tool boundaries for contained tests only.
 * @returns {Promise<object>} IO for updateComponents, with no controller, resume or alternate authentication path.
 */
export async function createOperatorLive(target, options, adapters = {}) {
  try {
    need(
      options &&
        Object.keys(options).every((key) =>
          [
            'params',
            'deploymentRecordFile',
            'grantFile',
            'artifactsFile',
            'privateWorkDir',
          ].includes(key)
        )
    );
    const p = admitComponentParameters(options.params);
    noSecrets(p);
    const url = new URL(target);
    need(
      url.protocol === 'https:' &&
        url.origin === target &&
        !url.username &&
        !url.password &&
        url.hostname !== 'a2'
    );
    for (const key of ['deploymentRecordFile', 'grantFile', 'artifactsFile', 'privateWorkDir'])
      admit(location, options[key]);
    const selection = await selectedArtifacts(options.artifactsFile);
    const deploymentRecord = async () => {
      const binding = admit(bindingSchema, await readOperatorJson(options.deploymentRecordFile));
      need(binding.origin === target);
      return binding;
    };
    const currentGrant = async () => readOperatorJson(options.grantFile);
    const initialBinding = await deploymentRecord();
    const sources = Object.fromEntries(
      await Promise.all(
        sourceNames.map(async (name) => [
          name,
          new TextDecoder('utf-8', { fatal: true }).decode(
            await readFile(fileURLToPath(new URL(name, import.meta.url)), { limit: 131_072 })
          ),
        ])
      )
    );
    const entry = new TextDecoder('utf-8', { fatal: true }).decode(
      await readFile(fileURLToPath(new URL('operator-entry.py', import.meta.url)), {
        limit: 131_072,
      })
    );
    const parent = await parentHandles(options.privateWorkDir);
    try {
      await fs.mkdir(parent.filename, { mode: 0o700 });
    } finally {
      for (const handle of parent.handles.reverse()) await handle.close().catch(() => {});
    }
    const attribution = {};
    const snapshots = {};
    const run = adapters.runProcess ?? runBoundedProcess;
    const verify =
      adapters.attributeArchive ??
      (async (input) => {
        const result = await run(process.execPath, ['--input-type=module', '-e', archiveVerifier], {
          input: Buffer.from(JSON.stringify(input)),
          timeoutMs: 180_000,
          maxStdoutBytes: 16_384,
          maxStderrBytes: 256,
        });
        need(
          result.exitCode === 0 &&
            result.signal === null &&
            result.timedOut === false &&
            result.stderr.length === 0
        );
        return json(result.stdout);
      });
    for (const kind of ['old', 'target']) {
      const item = selection[kind];
      const name = `openkit-nanohost-${item.tag}-${item.platform.replace('/', '-')}.tar.gz`;
      need(path.basename(item.archive) === name);
      const bytes = await readFile(item.archive, { limit: maxArchive });
      need(bytes.length > 0 && sha(bytes) === item.archiveSha256);
      const checksums = await readFile(item.checksumFile, { limit: 1_048_576 });
      const directory = path.join(options.privateWorkDir, kind);
      await fs.mkdir(directory, { mode: 0o700 });
      const archive = path.join(directory, name);
      const checksumFile = path.join(directory, 'SHA256SUMS');
      await fs.writeFile(archive, bytes, { flag: 'wx', mode: 0o600 });
      await fs.writeFile(checksumFile, checksums, { flag: 'wx', mode: 0o600 });
      snapshots[kind] = { archive, size: bytes.length, name };
      attribution[kind] = admitArchiveAttribution(
        await verify({
          ...item,
          archive,
          checksumFile,
          destdir: path.join(directory, `verify-${randomUUID()}`),
        })
      );
    }
    const archiveAttribution = async (kind) => {
      need(
        ['old', 'target'].includes(kind) &&
          canonical(await selectedArtifacts(options.artifactsFile)) === canonical(selection)
      );
      return structuredClone(attribution[kind]);
    };
    const admitted = await admitNanoHostReleasePair(target, p, {
      deploymentRecord,
      currentGrant,
      archiveAttribution,
    });
    const rawManifest = await run(
      'docker',
      [
        'buildx',
        'imagetools',
        'inspect',
        '--raw',
        `${admitted.selection.app.image}@${admitted.selection.child.digest}`,
      ],
      { timeoutMs: 30_000, maxStdoutBytes: 1_048_576, maxStderrBytes: 256 }
    );
    need(
      rawManifest.exitCode === 0 &&
        rawManifest.signal === null &&
        rawManifest.timedOut === false &&
        rawManifest.stderr.length === 0
    );
    const registry = json(rawManifest.stdout);
    need(
      registry.schemaVersion === 2 &&
        [
          'application/vnd.oci.image.manifest.v1+json',
          'application/vnd.docker.distribution.manifest.v2+json',
        ].includes(registry.mediaType)
    );
    const imageConfigDigest = admit(imageDigest, registry.config?.digest);
    const api = (adapters.createApi ?? createOperatorApi)(target);
    const inspection = (adapters.createTransport ?? createOperatorTransport)(deploymentRecord);
    let preparedRequest;
    let succeeded;
    let predecessor;
    const call = async (operation, input) => {
      try {
        const result = await api.call(operation, input);
        if (operation === 'app-update.prepare') {
          need(
            typeof result.requestId === 'string' &&
              z.string().uuid().safeParse(result.requestId).success
          );
          preparedRequest = result.requestId;
        }
        if (operation === 'app-update.status' && result.outcome === 'succeeded') {
          need(
            input.requestId === preparedRequest &&
              result.requestId === preparedRequest &&
              canonical(result.source) ===
                canonical({
                  tag: p.manifest.tag,
                  sourceCommit: p.manifest.sourceCommit,
                  appDigest: admitted.selection.app.digest,
                })
          );
          succeeded = structuredClone(result);
        }
        return result;
      } catch {
        throw Error(unavailable);
      }
    };
    const hostBinding = (binding) =>
      Object.fromEntries(
        ['origin', 'container', 'machineId', 'machineIdentityDigest'].map((key) => [
          key,
          binding[key],
        ])
      );
    const ssh = async (header, body, { timeoutMs = 60_000, signal } = {}) => {
      need(!signal?.aborted);
      const encoded = Buffer.from(JSON.stringify(header));
      need(encoded.length <= 262_144 && (!body || body.length <= maxArchive));
      const size = Buffer.alloc(4);
      size.writeUInt32BE(encoded.length);
      const input = Buffer.concat([size, encoded, ...(body ? [body] : [])]);
      const response = await run(
        'ssh',
        sshArguments(`sudo -n /usr/bin/python3 -I -B -c ${shellQuote(entry)}`),
        { input, timeoutMs, maxStdoutBytes: 16_384, maxStderrBytes: 256, signal }
      );
      need(
        [0, 1].includes(response.exitCode) &&
          response.signal === null &&
          response.timedOut === false &&
          response.stderr.length === 0 &&
          response.stdout.length > 0 &&
          response.stdout.length <= 16_384
      );
      const output = json(response.stdout);
      if (output?.outcome === 'unavailable') {
        need(
          response.exitCode === 1 &&
            typeof output.reason === 'string' &&
            output.action === (header.kind === 'identity' ? 'identity' : header.request.action) &&
            (header.kind === 'identity'
              ? Object.hasOwn(identityGuidance, output.reason)
              : reasons.has(output.reason)) &&
            Object.keys(output).sort().join(',') === 'action,outcome,reason'
        );
        if (header.kind === 'identity') throw new OperatorIdentityUnavailable(output.reason);
        throw new OperatorStepUnavailable(output.reason);
      }
      need(response.exitCode === 0);
      return output;
    };
    const observeIdentity = async (timeoutMs = 60_000, signal) => {
      const binding = await deploymentRecord();
      need(canonical(binding) === canonical(initialBinding));
      const app = succeeded
        ? { requestId: preparedRequest, source: succeeded.source, configDigest: imageConfigDigest }
        : null;
      const observed = await ssh(
        { kind: 'identity', binding: hostBinding(binding), helperSha256: p.app.helperSha256, app },
        null,
        { timeoutMs, signal }
      );
      need(
        observed.outcome === 'observed' &&
          observed.machineId === binding.machineId &&
          observed.machineIdentityDigest === binding.machineIdentityDigest &&
          observed.container === binding.container &&
          admit(hex, observed.containerId) &&
          observed.helperSha256 === p.app.helperSha256 &&
          imageDigest.safeParse(observed.appImageId).success
      );
      return observed;
    };
    const identities = async () => {
      try {
        const observed = await observeIdentity();
        const physical = {
          machineId: observed.machineId,
          machineIdentityDigest: observed.machineIdentityDigest,
          container: initialBinding.container,
          origin: target,
        };
        if (!succeeded) return physical;
        const diagnostics = await call('diagnostics.app', {});
        need(
          diagnostics.build?.sourceCommit === p.manifest.sourceCommit &&
            diagnostics.build.releaseTag === p.manifest.tag &&
            diagnostics.boot?.bootId === observed.candidateBoot?.bootId &&
            canonical(observed.source) === canonical(succeeded.source) &&
            observed.requestId === preparedRequest &&
            observed.appImageId === imageConfigDigest &&
            observed.candidateBoot?.imageId === imageConfigDigest &&
            observed.candidateBoot.sourceCommit === p.manifest.sourceCommit &&
            imageDigest.safeParse(observed.webTreeDigest).success &&
            observed.webTreeDigest === observed.webStagedDigest
        );
        return {
          ...physical,
          sourceCommit: p.manifest.sourceCommit,
          appDigest: admitted.selection.child.digest,
          webDigest: admitted.selection.child.digest,
          webTreeDigest: observed.webTreeDigest,
          webStagedDigest: observed.webStagedDigest,
        };
      } catch (error) {
        if (error instanceof OperatorIdentityUnavailable) throw error;
        throw Error(unavailable);
      }
    };
    const runNanoHostStep = async (selected, request) => {
      const controller = new AbortController();
      const maximum = ['preflight', 'install', 'start'].includes(request?.action)
        ? 180_000
        : 60_000;
      const deadline = performance.now() + maximum;
      let timer;
      const remaining = () => {
        need(!controller.signal.aborted && performance.now() < deadline);
        return Math.max(1, Math.floor(deadline - performance.now()));
      };
      try {
        const perform = async () => {
          need(
            selected === target &&
              request &&
              ['preflight', 'begin', 'vacate', 'install', 'start', 'finalize'].includes(
                request.action
              ) &&
              request.replacementId === p.nanoHost.replacementId
          );
          need(
            Object.keys(request).sort().join(',') ===
              [
                ...['action', 'replacementId', 'old', 'target'],
                ...(request.action === 'finalize' ? ['process'] : []),
              ]
                .sort()
                .join(',')
          );
          need(
            canonical(request.old) === canonical(attribution.old) &&
              canonical(request.target) === canonical(attribution.target)
          );
          if (request.action === 'finalize') admit(stamp, request.process);
          need(canonical(await currentGrant()) === canonical(admitted.grant));
          const physical = await observeIdentity(remaining(), controller.signal);
          remaining();
          need(succeeded && physical.appImageId === imageConfigDigest);
          const diagnostics = await call('diagnostics.app', {});
          remaining();
          need(
            diagnostics.build?.sourceCommit === p.manifest.sourceCommit &&
              diagnostics.build.releaseTag === p.manifest.tag &&
              diagnostics.boot?.bootId === physical.candidateBoot?.bootId
          );
          if (request.action === 'preflight') {
            predecessor = admit(
              NanoHostRuntimeTargetStatusResponseSchema.strip(),
              await call('nanohost.runtime-target', {})
            );
            need(
              predecessor.ready &&
                predecessor.freshEmpty &&
                predecessor.predecessorFenced &&
                predecessor.physicalEpoch !== null
            );
          }
          const header = {
            kind: 'nanohost-step',
            binding: hostBinding(initialBinding),
            containerId: physical.containerId,
            imageConfigDigest,
            request,
            sources,
            archive: {
              name: snapshots.target.name,
              size: snapshots.target.size,
              sha256: attribution.target.archiveSha256,
            },
          };
          const bytes =
            request.action === 'preflight'
              ? await readFile(snapshots.target.archive, { limit: maxArchive, privateFile: true })
              : null;
          if (bytes) need(sha(bytes) === attribution.target.archiveSha256);
          let beforeStart;
          if (request.action === 'start') {
            need(predecessor);
            beforeStart = admit(
              NanoHostRuntimeTargetStatusResponseSchema.strip(),
              await call('nanohost.runtime-target', {})
            );
            need(
              beforeStart.identityId === predecessor.identityId &&
                beforeStart.deploymentId === predecessor.deploymentId &&
                beforeStart.connectionGeneration === predecessor.connectionGeneration &&
                (beforeStart.physicalEpoch === null ||
                  beforeStart.physicalEpoch === predecessor.physicalEpoch)
            );
          }
          remaining();
          need(
            canonical(await currentGrant()) === canonical(admitted.grant) &&
              canonical(await deploymentRecord()) === canonical(initialBinding)
          );
          remaining();
          const output = await ssh(header, bytes, {
            timeoutMs: remaining(),
            signal: controller.signal,
          });
          remaining();
          need(output.action === request.action && output.outcome === 'passed');
          if (request.action !== 'start') return output;
          need(Object.keys(output).sort().join(',') === 'action,outcome,process');
          const process = admit(stamp, output.process);
          for (;;) {
            remaining();
            const status = admit(
              NanoHostRuntimeTargetStatusResponseSchema.strip(),
              await call('nanohost.runtime-target', {})
            );
            remaining();
            need(
              status.identityId === beforeStart.identityId &&
                status.deploymentId === beforeStart.deploymentId &&
                status.connectionGeneration >= beforeStart.connectionGeneration
            );
            if (status.ready) {
              need(
                status.freshEmpty &&
                  status.predecessorFenced &&
                  status.physicalEpoch !== null &&
                  status.physicalEpoch !== predecessor.physicalEpoch &&
                  status.connectionGeneration > predecessor.connectionGeneration
              );
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, Math.min(250, remaining())));
          }
          remaining();
          need(
            canonical(await currentGrant()) === canonical(admitted.grant) &&
              canonical(await deploymentRecord()) === canonical(initialBinding)
          );
          remaining();
          const controlled = await ssh(
            { ...header, kind: 'controlled-observation', controlledProcess: process },
            null,
            { timeoutMs: remaining(), signal: controller.signal }
          );
          need(
            controlled.action === 'start' &&
              controlled.outcome === 'passed' &&
              canonical(controlled.process) === canonical(process) &&
              hex.safeParse(controlled.controlledEffectiveStateDigest).success &&
              Object.keys(controlled).sort().join(',') ===
                'action,controlledEffectiveStateDigest,outcome,process'
          );
          return controlled;
        };
        return await Promise.race([
          perform(),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(Error(unavailable));
            }, maximum);
          }),
        ]);
      } catch (error) {
        if (
          error instanceof OperatorStepUnavailable ||
          error instanceof OperatorIdentityUnavailable
        )
          throw error;
        throw Error(unavailable);
      } finally {
        clearTimeout(timer);
      }
    };
    return {
      deploymentRecord,
      currentGrant,
      archiveAttribution,
      call,
      identities,
      runOperator: inspection.runOperator,
      runNanoHostStep,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    };
  } catch {
    throw Error(unavailable);
  }
}
