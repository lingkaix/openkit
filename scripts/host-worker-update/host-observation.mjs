/** Independent operator measurements joined to stored native-connection observations. */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { NanoHostRuntimeTargetStatusResponseSchema } from '@openkit/app-api-schemas';
import { parseTree } from 'jsonc-parser';
import { z } from 'zod';
import { canonical } from '../release-safety.mjs';
import { verifyNanoHostRelease } from '../verify-nanohost-release.mjs';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const processStamp = z.object({
  bootId: z.string().uuid(),
  pid: z.number().int().positive().max(2_147_483_647),
  startTimeTicks: z
    .string()
    .max(20)
    .regex(/^[1-9][0-9]*$/)
    .refine(
      (value) => /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n
    ),
});
// The public owner now carries the nullable stored witness. No local wire extension or old-response fallback is needed.
const StoredRuntimeTargetSchema = NanoHostRuntimeTargetStatusResponseSchema.strip();
// P02's accepted Live Operator Inspection owner (08b252dc) defines this wire shape.
// The effective-unit digest is opaque here; P02 owns its 40-property normalization.
const inspectionSchema = z.object({
  nonce: digest,
  outcome: z.literal('observed'),
  machineIdentityDigest: digest,
  physicalEpoch: digest,
  identityId: z.string().min(1),
  deploymentId: z.string().min(1),
  connectionGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  coordinator: processStamp,
  executables: z.object({
    nanohost: z.object({ process: processStamp, sha256: digest }),
    gateway: z.object({ process: processStamp, sha256: digest }),
  }),
  unit: z.object({
    fileSha256: digest,
    effectiveStateDigest: digest,
    activeState: z.literal('active'),
    subState: z.literal('running'),
  }),
  replacementDuringMeasurement: z.literal(false),
});
const archiveIdentitySchema = z.object({
  archiveSha256: digest,
  tag: z.string().regex(/^v\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?$/),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  platform: z.enum(['linux/amd64', 'linux/arm64']),
});
const archiveSchema = archiveIdentitySchema.extend({
  payloads: z.object({ nanohostSha256: digest, gatewaySha256: digest, unitFileSha256: digest }),
});
const observedHost = z.object({
  machineIdentityDigest: digest,
  physicalEpoch: digest,
  archiveAttribution: archiveSchema,
  inspection: inspectionSchema,
  runtimeTargetBefore: StoredRuntimeTargetSchema,
  runtimeTarget: StoredRuntimeTargetSchema,
});

/** Refuse without disclosing parser inputs, remote errors, paths or host properties. */
function requireFact(condition) {
  if (!condition) throw new Error('Host observation unavailable; inspect before any new effect.');
}

/** Strip descriptive annotations while requiring the complete authority-bearing shape. */
function admit(schema, raw) {
  const parsed = schema.safeParse(raw);
  requireFact(parsed.success);
  return parsed.data;
}

/** The exact current native connection and Epoch are one inseparable correlation tuple. */
function tuple(raw) {
  return [raw.identityId, raw.deploymentId, raw.connectionGeneration, raw.physicalEpoch];
}

/** Admission of verified archive facts; the administrator reader owns their independent provenance. */
export function admitArchiveAttribution(raw) {
  return admit(archiveSchema, raw);
}

/** Validate a retained qualified sample without treating its historical nonce as a new challenge. */
export function admitHostObservation(raw, { binding, archiveAttribution, effectiveStateDigest }) {
  const host = admit(observedHost, raw);
  const live = host.inspection;
  requireFact(
    host.machineIdentityDigest === binding.machineIdentityDigest &&
      live.machineIdentityDigest === host.machineIdentityDigest &&
      host.physicalEpoch === live.physicalEpoch &&
      host.physicalEpoch === host.runtimeTarget.physicalEpoch &&
      canonical(tuple(live)) === canonical(tuple(host.runtimeTarget)) &&
      canonical(tuple(host.runtimeTargetBefore)) === canonical(tuple(host.runtimeTarget)) &&
      host.runtimeTargetBefore.ready &&
      host.runtimeTargetBefore.freshEmpty &&
      host.runtimeTargetBefore.predecessorFenced &&
      host.runtimeTarget.ready &&
      host.runtimeTarget.freshEmpty &&
      host.runtimeTarget.predecessorFenced &&
      canonical(host.archiveAttribution) ===
        canonical(admitArchiveAttribution(archiveAttribution)) &&
      live.executables.nanohost.sha256 === host.archiveAttribution.payloads.nanohostSha256 &&
      live.executables.gateway.sha256 === host.archiveAttribution.payloads.gatewaySha256 &&
      live.unit.fileSha256 === host.archiveAttribution.payloads.unitFileSha256 &&
      live.unit.effectiveStateDigest === effectiveStateDigest &&
      digest.safeParse(effectiveStateDigest).success &&
      canonical(live.coordinator) === canonical(live.executables.nanohost.process) &&
      live.executables.gateway.process.bootId === live.coordinator.bootId &&
      live.executables.gateway.process.pid !== live.coordinator.pid
  );
  return host;
}

/**
 * Read/inspect/read once through independently authenticated administrator adapters.
 * P02 owns process-handle measurement, post-acknowledgement connection binding and its deadline.
 * P12 owns the stored projection; loss of inspection availability cannot reuse a prior sample.
 * No unknown/unavailable result is retried and no prior nonce can answer this challenge.
 * @param {string} target Explicit HTTPS origin selected by retained operator binding.
 * @param {object} expected Retained machine, verified archive and accepted effective unit digest.
 * @param {object} io Public administrator caller and bounded external operator command executor.
 * @returns {Promise<object>} Qualified private host evidence; never a live qualification verdict.
 */
export async function observeOperatorHost(target, expected, io) {
  try {
    const url = new URL(target);
    requireFact(
      url.protocol === 'https:' && url.origin === target && !url.username && !url.password
    );
    const baseline = structuredClone(expected);
    admitArchiveAttribution(baseline.archiveAttribution);
    requireFact(
      digest.safeParse(baseline.binding?.machineIdentityDigest).success &&
        digest.safeParse(baseline.effectiveStateDigest).success
    );
    const before = admit(StoredRuntimeTargetSchema, await io.call('nanohost.runtime-target', {}));
    requireFact(
      before.ready && before.freshEmpty && before.predecessorFenced && before.physicalEpoch !== null
    );
    const nonce = randomBytes(32).toString('hex');
    const live = admit(
      inspectionSchema,
      await invokeNanoHostInspection(target, { nonce }, io.runOperator)
    );
    requireFact(live.nonce === nonce);
    const after = admit(StoredRuntimeTargetSchema, await io.call('nanohost.runtime-target', {}));
    requireFact(canonical(tuple(before)) === canonical(tuple(after)));
    return admitHostObservation(
      {
        machineIdentityDigest: live.machineIdentityDigest,
        physicalEpoch: live.physicalEpoch,
        archiveAttribution: baseline.archiveAttribution,
        inspection: live,
        runtimeTargetBefore: before,
        runtimeTarget: after,
      },
      baseline
    );
  } catch {
    throw new Error('Host observation unavailable; inspect before any new effect.');
  }
}

/** Decode one strict UTF-8 JSON envelope without ambiguous duplicate properties. */
function inspectionJson(output) {
  requireFact(typeof output === 'string' || output instanceof Uint8Array);
  const bytes = typeof output === 'string' ? Buffer.from(output, 'utf8') : output;
  requireFact(bytes.byteLength > 0 && bytes.byteLength <= 16_384);
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const value = JSON.parse(text);
  const tree = parseTree(text);
  const visit = (node) => {
    if (node.type === 'object') {
      const keys = node.children.map((property) => property.children[0].value);
      requireFact(new Set(keys).size === keys.length);
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return value;
}

/**
 * Invoke P02's fixed producer through the already authenticated external operator tool.
 * The tool must bound collection and honor cancellation; this function never opens SSH or
 * selects a local installed host. Its caller supplies the retained host binding as target.
 * @param {string} target Explicit HTTPS origin bound to the external operator host session.
 * @param {{nonce:string}} request Fresh nonce only; no command or host selectors are accepted.
 * @param {Function} runOperator Bounded command executor on that authorized operator channel.
 * @returns {Promise<object>} Stripped observed or closed unavailable producer envelope.
 */
export async function invokeNanoHostInspection(target, request, runOperator) {
  let timer;
  try {
    const started = performance.now();
    const url = new URL(target);
    requireFact(
      url.protocol === 'https:' && url.origin === target && !url.username && !url.password
    );
    const input = admit(z.strictObject({ nonce: digest }), request);
    requireFact(typeof runOperator === 'function');
    const controller = new AbortController();
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Inspection deadline exceeded'));
      }, 10_000);
    });
    const result = await Promise.race([
      Promise.resolve().then(() =>
        runOperator(target, {
          command: ['/usr/lib/openkit/nanohost', 'inspect'],
          stdin: JSON.stringify(input),
          timeoutMs: 10_000,
          maxStdoutBytes: 16_384,
          maxStderrBytes: 256,
          signal: controller.signal,
        })
      ),
      deadline,
    ]);
    requireFact(
      performance.now() - started < 10_000 &&
        result?.exitCode === 0 &&
        result.signal === null &&
        result.timedOut === false
    );
    requireFact(
      (typeof result.stderr === 'string' || result.stderr instanceof Uint8Array) &&
        result.stderr.length === 0
    );
    const raw = inspectionJson(result.stdout);
    const envelope =
      raw?.outcome === 'observed'
        ? admit(inspectionSchema, raw)
        : admit(
            z.object({
              nonce: digest,
              outcome: z.literal('unavailable'),
              reason: z.enum([
                'not-running',
                'access-denied',
                'connection-unavailable',
                'process-changed',
                'measurement-unavailable',
                'unit-unavailable',
              ]),
            }),
            raw
          );
    requireFact(envelope.nonce === input.nonce);
    if (envelope.outcome === 'observed') {
      requireFact(
        canonical(envelope.coordinator) === canonical(envelope.executables.nanohost.process) &&
          envelope.executables.gateway.process.bootId === envelope.coordinator.bootId &&
          envelope.executables.gateway.process.pid !== envelope.coordinator.pid
      );
    }
    return envelope;
  } catch {
    throw new Error('NanoHost inspection unavailable; inspect before any new effect.');
  } finally {
    clearTimeout(timer);
  }
}

/** Hash regular files through an opened no-follow handle, without exporting their paths. */
function fileDigest(file) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    requireFact(fstatSync(fd).isFile());
    return createHash('sha256').update(readFileSync(fd)).digest('hex');
  } finally {
    closeSync(fd);
  }
}

/** Require the release verifier's checkout provenance to be the selected product commit. */
function requireCheckout(repoRoot, sourceCommit) {
  const result = spawnSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  requireFact(result.status === 0 && result.stdout.trim() === sourceCommit);
}

/**
 * Verify a private snapshot with the existing release owner, then hash its staged payloads.
 * Staging runs the existing DESTDIR-only installer; it cannot select installed host paths.
 * The caller retains the selected published checksum and source checkout as operator authority.
 * @param {object} input Archive/checksum paths, source repoRoot, new private destdir, and selected release identity.
 * @returns {object} Supply attribution plus exact verified payload hashes, not running-image proof.
 */
export function attributeNanoHostArchive(input) {
  let temporary;
  let attribution;
  try {
    const { archive, checksumFile, repoRoot, destdir, tag, sourceCommit, platform, archiveSha256 } =
      input;
    admit(archiveIdentitySchema, { archiveSha256, tag, sourceCommit, platform });
    requireFact(
      path.basename(archive) === `openkit-nanohost-${tag}-${platform.replace('/', '-')}.tar.gz`
    );
    requireFact(path.isAbsolute(destdir) && path.normalize(destdir) === destdir && destdir !== '/');
    requireCheckout(repoRoot, sourceCommit);
    temporary = mkdtempSync(path.join(path.dirname(destdir), 'archive-observation-'));
    const snapshot = path.join(temporary, path.basename(archive));
    const checksums = path.join(temporary, 'SHA256SUMS');
    copyFileSync(archive, snapshot, constants.COPYFILE_EXCL);
    copyFileSync(checksumFile, checksums, constants.COPYFILE_EXCL);
    requireFact(fileDigest(snapshot) === archiveSha256);
    verifyNanoHostRelease({ archive: snapshot, checksumFile: checksums, repoRoot, destdir });
    requireCheckout(repoRoot, sourceCommit);
    requireFact(fileDigest(snapshot) === archiveSha256);
    attribution = admitArchiveAttribution({
      archiveSha256,
      tag,
      sourceCommit,
      platform,
      payloads: {
        nanohostSha256: fileDigest(path.join(destdir, 'usr/lib/openkit/nanohost')),
        gatewaySha256: fileDigest(path.join(destdir, 'usr/lib/openkit/openshell-gateway')),
        unitFileSha256: fileDigest(
          path.join(destdir, 'etc/systemd/system/openkit-nanohost.service')
        ),
      },
    });
  } catch {
    // Verifier diagnostics can include local paths; only the fixed failure below escapes.
    attribution = undefined;
  }
  if (temporary) {
    try {
      rmSync(temporary, { recursive: true, force: true });
    } catch {
      attribution = undefined;
    }
  }
  if (!attribution) {
    throw new Error('NanoHost archive attribution unavailable; no dependent effect permitted.');
  }
  return attribution;
}
