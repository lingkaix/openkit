import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  type AuditEvent,
  AuditEventSchema,
  compareCodeUnits,
  KnowledgeBaseIdSchema,
  readRetainedV1,
  WorkspaceIdSchema,
  writeRetainedV1,
} from '@openkit/protocol';
import { sha256Hex } from '@openkit/protocol/digest';
import { publishDurableFile, STORAGE_LIMITS, type StorageContent } from '@openkit/storage';
import { z } from 'zod';
import type { KnowledgeNotebook } from '../knowledge/notebook.js';
import { parseScopeKnowledgeSchema } from '../knowledge/okf.js';
import type { KnowledgeProposalRecord } from '../lib/store.js';
import {
  ensureCanonicalDirectoryAsync,
  syncCanonicalDirectoryAsync,
} from './canonical-filesystem.js';
import {
  type ControlKnowledgeHead,
  type ControlKnowledgeProposal,
  controlKnowledgeContentSchema,
  decodeControlKnowledgeHead,
  decodeProposal,
  validateProposalReviews,
} from './control-store-knowledge-heads.js';
import type { WorkspaceDb } from './db.js';
import {
  type ImmutableContentHandoff,
  publishImmutableContent,
  verifyImmutableWinner,
} from './immutable-content-publish.js';
import {
  KnowledgeProposalRecordSchema,
  serializeKnowledgeProposalRecord,
} from './knowledge-proposal-codecs.js';

export {
  type ControlKnowledgeHead,
  type ControlKnowledgeProposal,
  type ControlKnowledgeProposalState,
  controlKnowledgeHeadGuardStatement,
  controlKnowledgeHeadStatements,
  controlKnowledgeProposalStatement,
  controlKnowledgeReviewStatement,
  readControlKnowledgeHead,
  readControlKnowledgeProposal,
} from './control-store-knowledge-heads.js';

const requiredKnowledgeFeaturesSchema = z.array(z.never());

/** Captures sealed byte facts before awaits while retaining the request's live Storage admission. */
function verifiedKnowledgeHandoff(
  db: WorkspaceDb,
  knowledgeBaseId: string,
  originalText: string,
  content: ImmutableContentHandoff
): ImmutableContentHandoff {
  WorkspaceIdSchema.parse(db.workspaceId);
  KnowledgeBaseIdSchema.parse(knowledgeBaseId);
  if (db.scope !== 'workspace' || !db.sqlite.open || db.sqlite.inTransaction)
    throw new TypeError('Knowledge preparation requires an open Workspace outside SQL.');
  const stored = controlKnowledgeContentSchema.parse(content.stage.content);
  const { reference } = stored;
  const handoff: ImmutableContentHandoff = {
    storage: content.storage,
    mountRoot: content.mountRoot,
    access: content.access,
    stage: { handle: content.stage.handle, content: stored },
  };
  if (
    reference.knowledgeBaseId !== knowledgeBaseId ||
    reference.locator.ownerScope.kind !== 'workspace' ||
    reference.locator.ownerScope.workspaceId !== db.workspaceId ||
    reference.range !== null ||
    reference.availability !== 'available' ||
    handoff.access.knowledgeBaseId !== knowledgeBaseId ||
    handoff.access.ownerScope.kind !== 'workspace' ||
    handoff.access.ownerScope.workspaceId !== db.workspaceId ||
    handoff.access.mode !== 'staged-write' ||
    handoff.access.mount !== reference.locator.mount ||
    Buffer.from(originalText, 'utf8').toString('utf8') !== originalText ||
    Buffer.byteLength(originalText, 'utf8') !== stored.byteLength ||
    `sha256:${sha256Hex(originalText)}` !== reference.contentDigest
  )
    throw new TypeError('Knowledge preparation has inconsistent admitted input.');
  return handoff;
}

/**
 * Verifies an admitted schema stage and publishes its exact original bytes before later head SQL.
 *
 * The caller owns current admission, the existing bounded input/stage lifetime and
 * the actual private Notebook binding. Fresh Git writes use the Notebook's existing
 * fsync policy; this inspection is not a synchronization proof for historical carry.
 * No SQL transaction may span preparation. The returned facts grant no Review,
 * receipt, access, current-head selection or authority-transfer permission.
 *
 * @param input Explicit Workspace/KB, original admitted text and its sealed Storage handoff.
 * @returns Exact immutable facts for a later complete native conditional transaction.
 * @throws Before publication on an invalid schema, identity, text/stage mismatch or unavailable commit.
 */
export async function prepareControlKnowledgeHead(input: {
  readonly db: WorkspaceDb;
  readonly knowledgeBaseId: string;
  readonly notebook: KnowledgeNotebook;
  readonly notebookCommit: string;
  readonly schemaText: string;
  readonly content: ImmutableContentHandoff;
}): Promise<ControlKnowledgeHead> {
  const { db, knowledgeBaseId, notebook, notebookCommit, schemaText } = input;
  const handoff = verifiedKnowledgeHandoff(db, knowledgeBaseId, schemaText, input.content);
  if (!parseScopeKnowledgeSchema(schemaText).ok)
    throw new TypeError('Knowledge schema preparation has inconsistent admitted input.');
  await notebook.inspectRevisionAsync(notebookCommit);
  // The existing publisher rechecks the real sealed bytes and digest, then fsyncs
  // the create-only object and its directory. It never receives re-encoded YAML.
  const published = await publishImmutableContent(handoff);
  return decodeControlKnowledgeHead({
    workspaceId: db.workspaceId,
    knowledgeBaseId,
    notebookCommit,
    schemaContent: published,
    requiredFeatures: [],
  });
}

/**
 * Verifies and synchronizes the original Proposal document before later native SQL.
 *
 * The existing serializer preserves retained original bytes. Immutable Git readers
 * verify the declared candidate, parent and producer; no ref is advanced. Current
 * human/Source authority, the actual private Notebook binding, bounded stage lifetime
 * and historical Git synchronization remain with the admitting caller. No SQL
 * transaction may span preparation, and this result grants no Review or publication.
 *
 * @param input Original admitted Proposal, its explicit owner, real Notebook and sealed document stage.
 * @returns Compact immutable selection after exact original-byte publication and synchronization.
 * @throws Before document publication if bytes, scope, candidate or retained lineage contradict.
 */
export async function prepareControlKnowledgeProposal(input: {
  readonly db: WorkspaceDb;
  readonly knowledgeBaseId: string;
  readonly notebook: KnowledgeNotebook;
  readonly proposal: KnowledgeProposalRecord;
  readonly content: ImmutableContentHandoff;
}): Promise<ControlKnowledgeProposal> {
  const originalText = serializeKnowledgeProposalRecord(input.proposal);
  const handoff = verifiedKnowledgeHandoff(
    input.db,
    input.knowledgeBaseId,
    originalText,
    input.content
  );
  const facts = await verifyKnowledgeProposalFacts(input);
  const documentContent = await publishImmutableContent(handoff);
  return decodeProposal({ ...facts, documentContent });
}

/** Verifies the same original Git/Proposal tuple for staged and native-private byte publication. */
async function verifyKnowledgeProposalFacts(input: {
  readonly db: WorkspaceDb;
  readonly knowledgeBaseId: string;
  readonly notebook: KnowledgeNotebook;
  readonly proposal: KnowledgeProposalRecord;
}) {
  const proposal = KnowledgeProposalRecordSchema.parse(input.proposal);
  const { db, knowledgeBaseId, notebook } = input;
  WorkspaceIdSchema.parse(db.workspaceId);
  KnowledgeBaseIdSchema.parse(knowledgeBaseId);
  if (db.scope !== 'workspace' || !db.sqlite.open || db.sqlite.inTransaction)
    throw new TypeError('Knowledge preparation requires an open Workspace outside SQL.');
  if (
    proposal.workspaceId !== db.workspaceId ||
    proposal.ownerScope.kind !== 'workspace' ||
    proposal.ownerScope.workspaceId !== db.workspaceId
  )
    throw new TypeError('Knowledge Proposal preparation has inconsistent ownership.');
  const candidate = await notebook.inspectRevisionAsync(proposal.candidateRevision);
  await notebook.inspectRevisionAsync(proposal.baseRevision);
  if (
    candidate.parentRevision !== proposal.baseRevision ||
    candidate.metadata.authority.kind !== 'proposal' ||
    candidate.metadata.authority.proposalId !== proposal.id ||
    !isDeepStrictEqual(candidate.metadata.producer, proposal.producer) ||
    !isDeepStrictEqual(candidate.metadata.sourceReferences, proposal.sourceReferences)
  )
    throw new TypeError('Knowledge Proposal contradicts its immutable candidate lineage.');

  let contentDigest: string;
  if (proposal.changes) {
    // Reuse both native immutable readers and their existing reserved Source edit paths.
    const readContent = async (revision: string) => {
      const pages = await notebook.readRevisionAsync(revision);
      const sources = await notebook.readSourcePointersAsync(revision);
      return {
        ...pages.files,
        ...Object.fromEntries(
          Object.entries(sources).map(([id, bytes]) => [`@sources/${id}.md`, bytes])
        ),
      };
    };
    const [base, next] = await Promise.all([
      readContent(proposal.baseRevision),
      readContent(proposal.candidateRevision),
    ]);
    const changes = [...new Set([...Object.keys(base), ...Object.keys(next)])]
      .sort(compareCodeUnits)
      .filter((path) => base[path] !== next[path])
      .map((path) => ({ path, content: next[path] ?? null }));
    if (!isDeepStrictEqual(changes, proposal.changes))
      throw new TypeError('Knowledge Proposal content contradicts its immutable candidate.');
    contentDigest = `sha256:${sha256Hex(JSON.stringify(changes))}`;
  } else {
    const path = `${proposal.knowledgePageId}.md`;
    const actual = await notebook.readRevisionAsync(proposal.candidateRevision, [path]);
    if (actual.files[path] !== proposal.canonicalPageBytes)
      throw new TypeError('Knowledge Proposal content contradicts its immutable candidate.');
    contentDigest = `sha256:${sha256Hex(actual.files[path]!)}`;
  }
  if (contentDigest !== proposal.contentDigest)
    throw new TypeError('Knowledge Proposal content digest contradicts its immutable candidate.');
  return {
    workspaceId: db.workspaceId,
    knowledgeBaseId,
    proposalId: proposal.id,
    baseRevision: proposal.baseRevision,
    candidateRevision: proposal.candidateRevision,
    contentDigest,
    target: proposal.changes
      ? { changedPageIds: proposal.changes.map(({ path }) => path.slice(0, -3)) }
      : { knowledgePageId: proposal.knowledgePageId },
    requiredFeatures: [],
  };
}

/** Prepared one-way carry on the exact pre-serving Workspace connection; not a live publication grant. */
export interface PreparedKnowledgeAuthorityTransfer {
  readonly workspaceDb: WorkspaceDb;
  readonly initialAudits: readonly AuditEvent[];
  readonly heads: readonly { readonly knowledgeBaseId: string; readonly recordJson: string }[];
  readonly proposals: readonly {
    readonly knowledgeBaseId: string;
    readonly proposalId: string;
    readonly recordJson: string;
    readonly reviewsJson: string;
  }[];
}

/**
 * Captures verified predecessor selections for the native activation transaction.
 *
 * The boot/staging owner must exclude serving, validate the complete old inventory
 * and synchronize referenced Git and Storage bytes before calling this function.
 * Original command receipts and Audit already belong to this database and remain
 * unchanged. This does not infer ownership, recover split outcomes or seed a
 * missing admitted head. The final live switch alone installs the activation tag.
 *
 * @param input Actual Workspace connection, exact prepared heads and original ordered Reviews.
 * @returns Bound row facts for the specific migration's fixed SQL, transaction and ledger.
 */
export function prepareControlKnowledgeAuthorityTransfer(input: {
  readonly db: WorkspaceDb;
  readonly initialAudits?: readonly AuditEvent[];
  readonly heads: readonly ControlKnowledgeHead[];
  readonly proposals: readonly {
    readonly proposal: ControlKnowledgeProposal;
    readonly reviews: readonly unknown[];
  }[];
}): PreparedKnowledgeAuthorityTransfer {
  const { db } = input;
  if (db.scope !== 'workspace' || !db.sqlite.open || db.sqlite.inTransaction || !input.heads.length)
    throw new TypeError(
      'Knowledge authority transfer requires its open Workspace and exact heads.'
    );
  const heads = new Set<string>();
  const headRows: PreparedKnowledgeAuthorityTransfer['heads'][number][] = [];
  const proposalRows: PreparedKnowledgeAuthorityTransfer['proposals'][number][] = [];
  for (const head of input.heads) {
    if (head.workspaceId !== db.workspaceId || heads.has(head.knowledgeBaseId))
      throw new TypeError('Knowledge authority transfer has inconsistent head ownership.');
    heads.add(head.knowledgeBaseId);
    const selection = decodeControlKnowledgeHead({ ...head, requiredFeatures: [] });
    headRows.push({
      knowledgeBaseId: selection.knowledgeBaseId,
      recordJson: JSON.stringify(writeRetainedV1({ ...selection, requiredFeatures: [] })),
    });
  }
  const proposals = new Set<string>();
  for (const { proposal, reviews } of input.proposals) {
    if (
      proposal.workspaceId !== db.workspaceId ||
      !heads.has(proposal.knowledgeBaseId) ||
      proposals.has(proposal.proposalId)
    )
      throw new TypeError('Knowledge authority transfer has inconsistent Proposal ownership.');
    proposals.add(proposal.proposalId);
    // Legacy decisions are inside the retained Review-file envelope. Preserve
    // every descriptive field while validating any already-present core markers.
    const rawReviews = reviews.map((review) => {
      if (!review || typeof review !== 'object' || Array.isArray(review))
        throw new TypeError('Knowledge authority transfer has invalid Review metadata.');
      const record = review as Record<string, unknown>;
      if ('schemaVersion' in record) readRetainedV1(record, (value) => value);
      if ('requiredFeatures' in record)
        requiredKnowledgeFeaturesSchema.parse(record.requiredFeatures);
      return writeRetainedV1({ ...record, requiredFeatures: [] });
    });
    validateProposalReviews(proposal, rawReviews);
    const selection = decodeProposal({ ...proposal, requiredFeatures: [] });
    proposalRows.push({
      knowledgeBaseId: selection.knowledgeBaseId,
      proposalId: selection.proposalId,
      recordJson: JSON.stringify(writeRetainedV1({ ...selection, requiredFeatures: [] })),
      reviewsJson: JSON.stringify(rawReviews),
    });
  }
  const initialAudits = (input.initialAudits ?? []).map((event) => AuditEventSchema.parse(event));
  if (
    initialAudits.length &&
    (initialAudits.length !== 2 ||
      initialAudits.some(
        (event) =>
          event.workspaceId !== db.workspaceId ||
          !event.notebookAdmission ||
          event.notebookAdmission.baseRevision !== null ||
          !input.heads.some(
            (head) => head.notebookCommit === event.notebookAdmission?.candidateRevision
          )
      ) ||
      initialAudits[0]!.action !== 'knowledge.notebook.admit' ||
      initialAudits[1]!.action !== 'knowledge.notebook.initialize')
  )
    throw new TypeError('Knowledge initialization requires its original complete Audit tuple.');
  return { workspaceDb: db, heads: headRows, proposals: proposalRows, initialAudits };
}

/** Publishes already-admitted private metadata through Storage's existing create-only durable primitive. */
async function publishWorkspaceKnowledgeBytes(input: {
  readonly db: WorkspaceDb;
  readonly workspaceRoot: string;
  readonly knowledgeBaseId: string;
  readonly text: string;
  readonly mediaType: string;
}): Promise<StorageContent> {
  WorkspaceIdSchema.parse(input.db.workspaceId);
  KnowledgeBaseIdSchema.parse(input.knowledgeBaseId);
  if (input.db.scope !== 'workspace' || !input.db.sqlite.open || input.db.sqlite.inTransaction)
    throw new TypeError('Knowledge preparation requires its open Workspace outside SQL.');
  const bytes = Buffer.from(input.text, 'utf8');
  if (bytes.toString('utf8') !== input.text || bytes.length > STORAGE_LIMITS.contentBytes)
    throw new TypeError('Knowledge immutable input is invalid.');
  const digest = `sha256:${sha256Hex(bytes)}`;
  const relativePath = `sha256/${digest.slice(7)}`;
  const destination = join(input.workspaceRoot, 'knowledge', 'content', relativePath);
  await ensureCanonicalDirectoryAsync(dirname(destination));
  try {
    await publishDurableFile({ destinationPath: destination, bytes, mode: 0o444 });
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    await verifyImmutableWinner(destination, digest, bytes.length);
    await syncCanonicalDirectoryAsync(dirname(destination));
  }
  return {
    reference: {
      knowledgeBaseId: input.knowledgeBaseId,
      contentDigest: digest,
      locator: {
        ownerScope: { kind: 'workspace', workspaceId: input.db.workspaceId },
        mount: 'private',
        path: relativePath,
      },
      range: null,
      availability: 'available',
    },
    byteLength: bytes.length,
    mediaType: input.mediaType,
  };
}

/** Publishes exact selected schema bytes before a later native head/CAS transaction. */
export async function prepareWorkspaceKnowledgeSelection(input: {
  readonly db: WorkspaceDb;
  readonly workspaceRoot: string;
  readonly notebook: KnowledgeNotebook;
  readonly knowledgeBaseId: string;
  readonly notebookCommit: string;
  readonly schemaText: string;
}): Promise<ControlKnowledgeHead> {
  if (!parseScopeKnowledgeSchema(input.schemaText).ok)
    throw new TypeError('Knowledge schema preparation has inconsistent admitted input.');
  await input.notebook.inspectRevisionAsync(input.notebookCommit);
  const schemaContent = await publishWorkspaceKnowledgeBytes({
    ...input,
    text: input.schemaText,
    mediaType: 'application/yaml',
  });
  return decodeControlKnowledgeHead({
    workspaceId: input.db.workspaceId,
    knowledgeBaseId: input.knowledgeBaseId,
    notebookCommit: input.notebookCommit,
    schemaContent,
    requiredFeatures: [],
  });
}

/** Retains the exact original Proposal document through Storage's private immutable publication. */
export async function prepareWorkspaceKnowledgeProposal(input: {
  readonly db: WorkspaceDb;
  readonly workspaceRoot: string;
  readonly notebook: KnowledgeNotebook;
  readonly knowledgeBaseId: string;
  readonly proposal: KnowledgeProposalRecord;
}): Promise<ControlKnowledgeProposal> {
  const originalText = serializeKnowledgeProposalRecord(input.proposal);
  const facts = await verifyKnowledgeProposalFacts(input);
  const documentContent = await publishWorkspaceKnowledgeBytes({
    ...input,
    text: originalText,
    mediaType: 'text/markdown',
  });
  return decodeProposal({ ...facts, documentContent });
}
