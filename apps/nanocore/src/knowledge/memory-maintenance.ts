import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseRecordEnvelope, RecordEnvelopeSchema } from '@openkit/config-schema';
import { UserIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import {
  appendCanonicalTextFile,
  assertCanonicalDirectory,
  readCanonicalJsonLines,
} from '../storage/workspace-file-records.js';
import { NotebookError, validateNotebookFiles } from './notebook.js';

const REQUIRED_FEATURES = ['openkit.memory-suppression.v1'] as const;
const PayloadSchema = z.object({
  pageId: z.string().min(1),
  lastRevision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  // This native slice refuses Source-bearing content. It cannot manufacture a source fingerprint.
  sourceFingerprints: z.array(z.string()).length(0),
  actorId: UserIdSchema,
});
const SuppressionSchema = z.object({
  schemaVersion: z.literal(1),
  recordType: z.literal('memory-suppression'),
  id: z.uuid(),
  ownerScope: z.literal('user'),
  lineage: z.object({ userId: UserIdSchema, knowledgeId: z.string().min(1), requestId: z.uuid() }).strict(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  redactionLevel: z.literal('none'),
  sensitivity: z.literal('confidential'),
  requiredFeatures: z.tuple([z.literal(REQUIRED_FEATURES[0])]),
  extensions: z.object({}),
  payload: PayloadSchema,
});

/** Full canonical, content-free suppression record in the existing scoped observations family. */
export type MemorySuppression = z.infer<typeof SuppressionSchema>;

/** Fixed unavailability exposes neither a suppressed identity nor its retained content. */
export class MemoryPageUnavailableError extends Error {
  constructor() {
    super('Memory page unavailable.');
    this.name = 'MemoryPageUnavailableError';
  }
}

/** Hashes the strict owned payload; descriptive additions never become suppression authority. */
function contentDigest(payload: z.infer<typeof PayloadSchema>): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
}

/** Reads current suppression without repair, with the shared envelope's required-feature checks. */
export function readMemorySuppressions(notebookRoot: string, userId: string): readonly MemorySuppression[] {
  try {
    assertCanonicalDirectory(notebookRoot);
    const directory = join(notebookRoot, 'observations');
    if (!lstatSync(directory, { throwIfNoEntry: false })) return [];
    assertCanonicalDirectory(directory);
    const rows: MemorySuppression[] = [];
    const requests = new Set<string>();
    const pageIds = new Set<string>();
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !/^\d{6}\.jsonl$/.test(entry.name)) throw new Error('Invalid maintenance ledger.');
      for (const raw of readCanonicalJsonLines(join(directory, entry.name))) {
        const envelope = parseRecordEnvelope(raw, { supportedFeatures: REQUIRED_FEATURES });
        const row = SuppressionSchema.parse(envelope);
        validateNotebookFiles({ [`${row.payload.pageId}.md`]: '' }, true);
        if (row.lineage.userId !== userId || row.payload.actorId !== userId ||
          row.lineage.knowledgeId !== row.payload.pageId || row.lineage.requestId !== row.id ||
          row.createdAt !== row.updatedAt || row.contentDigest !== contentDigest(row.payload) ||
          row.createdAt.slice(0, 7).replace('-', '') !== entry.name.slice(0, 6)) throw new Error('Invalid suppression evidence.');
        if (requests.has(row.id) || pageIds.has(row.payload.pageId)) throw new Error('Contradictory suppression history.');
        requests.add(row.id);
        pageIds.add(row.payload.pageId);
        rows.push(row);
      }
    }
    return rows;
  } catch {
    throw new NotebookError('recovery_required');
  }
}

/** Appends one full canonical row through existing append/fsync IO; the native caller owns confirmation and exact target admission. */
export function appendMemorySuppression(notebookRoot: string, input: {
  readonly userId: string; readonly requestId: string; readonly pageId: string;
  readonly lastRevision: string; readonly digest: string; readonly actorId: string;
}): MemorySuppression {
  try {
    const payload = PayloadSchema.strict().parse({ pageId: input.pageId, lastRevision: input.lastRevision,
      digest: input.digest, sourceFingerprints: [], actorId: input.actorId });
    validateNotebookFiles({ [`${payload.pageId}.md`]: '' }, true);
    const now = new Date().toISOString();
    const row = SuppressionSchema.strict().parse(RecordEnvelopeSchema.parse({
      schemaVersion: 1, recordType: 'memory-suppression', id: input.requestId, ownerScope: 'user',
      lineage: { userId: input.userId, knowledgeId: payload.pageId, requestId: input.requestId },
      createdAt: now, updatedAt: now, contentDigest: contentDigest(payload), redactionLevel: 'none',
      sensitivity: 'confidential', requiredFeatures: [...REQUIRED_FEATURES], extensions: {}, payload,
    }));
    assertCanonicalDirectory(notebookRoot);
    const directory = join(notebookRoot, 'observations');
    if (!lstatSync(directory, { throwIfNoEntry: false })) mkdirSync(directory, { mode: 0o700 });
    assertCanonicalDirectory(directory);
    appendCanonicalTextFile(join(directory, `${now.slice(0, 7).replace('-', '')}.jsonl`), `${JSON.stringify(row)}\n`);
    return row;
  } catch {
    throw new NotebookError('recovery_required');
  }
}

/** User publication refuses retained suppressed identities, including historical replay and pending candidates. */
export function assertMemoryPagesNotSuppressed(notebookRoot: string, userId: string, paths: readonly string[]): void {
  const suppressed = new Set(readMemorySuppressions(notebookRoot, userId).map(({ payload }) => `${payload.pageId}.md`));
  if (paths.some((path) => suppressed.has(path))) throw new MemoryPageUnavailableError();
}
