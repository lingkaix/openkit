import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeRetainedV1 } from '@openkit/protocol';
import { discardStagedFiles, linkStagedFiles, removeConsumedStagedFile } from '@openkit/storage';
import { PendingRequestCommandError } from '../runtime/pending-request-error.js';
import {
  applyControlPendingCommand,
  type ControlPendingCommandInput,
  type ControlPendingCommandResult,
  type PreparedControlPendingCommand,
  pendingOutcomeBatchDraft,
  readPendingRequest,
} from '../runtime/pending-requests.js';
import {
  applyControlPendingTransition,
  type ControlPendingTransition,
  prepareControlPendingCommands,
} from './control-store-pending.js';
import {
  type ControlPendingPlan,
  ControlPendingPlanHeaderSchema,
  ControlPendingPlanSchema,
  controlPendingPlanInputs,
  parseControlPendingPlanGroup,
} from './control-store-pending-plan.js';
import {
  type ControlProductContentMount,
  type ControlProductEntry,
  type ControlProductOwner,
  ControlProductPreconditionError,
  type ControlProductTransition,
  readProduct,
} from './control-store-product-records.js';
import {
  applyControlProducts,
  applyControlPublication,
  applyControlTerminal,
  type ControlContentPreparation,
  type ControlPublicationInput,
  type ControlTerminalTransition,
  type PreparedControlEntry,
  type PreparedControlPublication,
  type PreparedControlTerminal,
  prepareControlEntries,
  prepareControlItemAppend,
  prepareControlPublication,
  prepareControlTerminal,
  preparedControlPublicationEntries,
  preparedControlTerminalEntries,
  readControlContentFile,
} from './control-store-products.js';
import type { WorkspaceDb } from './db.js';
import { prepareRetainedProductJson } from './immutable-content.js';
import { prepareWorkspaceQueueInputBatch } from './workspace-queue-inputs.js';

type PreparedGroup =
  | {
      readonly kind: 'pending';
      readonly input: ControlPendingTransition;
      readonly pending: PreparedControlPendingCommand;
      readonly terminal?: PreparedControlTerminal | undefined;
    }
  | {
      readonly kind: 'products';
      readonly transition: ControlProductTransition;
      readonly entries: readonly PreparedControlEntry[];
      readonly pending?: PreparedControlPendingCommand | undefined;
    }
  | {
      readonly kind: 'terminal';
      readonly input: ControlTerminalTransition;
      readonly terminal: PreparedControlTerminal;
    }
  | {
      readonly kind: 'item';
      readonly turnId: string;
      readonly headRevision: number;
      readonly headRecord: Record<string, unknown>;
      readonly entries?: readonly PreparedControlEntry[];
      readonly publication?: {
        readonly input: ControlPublicationInput;
        readonly prepared: PreparedControlPublication;
      };
    };

/** A verified plan with every group prepared outside SQL and no new canonical name linked. */
export interface PreparedControlPendingPlan {
  readonly workspaceId: string;
  readonly operation: ControlPendingPlan['plan']['operation'];
  readonly threadId: string | null;
  readonly inputs: string;
  readonly groups: readonly PreparedGroup[];
  readonly content: ControlContentPreparation & {
    readonly deferred: { readonly temporary: string; readonly path: string }[];
  };
}

/**
 * Verifies the exact private plan bytes and prepares its ordered groups outside SQL, on the
 * existing preparation of each packet. New bodies stay private: their names are deferred until the
 * grouped decision passes its last definite local refusal. The staged plan is consumed here and
 * confers no replay authority.
 */
export async function prepareControlPendingPlan(
  db: WorkspaceDb,
  owner: ControlProductOwner,
  mount: ControlProductContentMount,
  value: ControlPendingPlan
): Promise<PreparedControlPendingPlan> {
  const { plan } = ControlPendingPlanSchema.parse(value);
  if (db.sqlite.inTransaction || plan.workspaceId !== db.workspaceId)
    throw new ControlProductPreconditionError();
  const path = join(mount.root, plan.temporary);
  if (!plan.temporary.startsWith(`.${plan.contentDigest.slice('sha256:'.length)}.`))
    throw new ControlProductPreconditionError();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    bytes = await readControlContentFile(file, {
      byteLength: plan.byteLength,
      reference: { contentDigest: plan.contentDigest },
    } as Parameters<typeof readControlContentFile>[1]);
  } finally {
    await file.close();
  }
  await removeConsumedStagedFile(path);
  const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\n');
  if (lines.pop() !== '') throw new ControlProductPreconditionError();
  const header = ControlPendingPlanHeaderSchema.parse(JSON.parse(lines[0] ?? ''));
  if (
    header.workspaceId !== plan.workspaceId ||
    header.operation !== plan.operation ||
    (header.operation === 'pending-closeout') !== (header.threadId !== null) ||
    header.groups !== lines.length - 1
  )
    throw new ControlProductPreconditionError();
  const planned = new Map<string, PreparedControlEntry>();
  const frozen = new Map<string, Set<string>>();
  const content = {
    db,
    directories: new Set<string>(),
    publications: new Map(),
    published: new Set<string>(),
    deferred: [] as { temporary: string; path: string }[],
    planned,
    frozen,
  };
  // A later delivery command on the same Turn prepares the rows this freeze selects.
  const freezes = (commands: readonly ControlPendingCommandInput[]) => {
    for (const command of commands)
      if (command.action === 'freeze') {
        const rows = frozen.get(command.turnId) ?? new Set<string>();
        for (const requestId of command.expectedSelection) rows.add(requestId);
        frozen.set(command.turnId, rows);
      }
  };
  const plannedSequence = new Map<string, number>();
  const note = (entries: readonly PreparedControlEntry[]) => {
    for (const entry of entries)
      if (entry.input.kind === 'item') {
        planned.set(entry.id, entry);
        plannedSequence.set(
          entry.input.turnId,
          Math.max(plannedSequence.get(entry.input.turnId) ?? 0, entry.input.sequence)
        );
      }
  };
  const groups: PreparedGroup[] = [];
  let carried: ControlProductEntry[] = [];
  for (const line of lines.slice(1)) {
    const group = parseControlPendingPlanGroup(JSON.parse(line));
    if (
      carried.length &&
      group.kind !== 'entries' &&
      group.kind !== 'terminal' &&
      !(group.kind === 'pending' && group.input.terminal)
    )
      throw new ControlProductPreconditionError();
    if (group.kind === 'entries') {
      carried.push(...group.entries);
      continue;
    }
    if (group.kind === 'pending') {
      let terminal: PreparedControlTerminal | undefined;
      let entries: readonly PreparedControlEntry[] | undefined;
      if (group.input.terminal)
        terminal = await prepareControlTerminal(db, group.input.terminal, mount, content, carried);
      else {
        entries = await prepareControlEntries(
          owner,
          mount,
          group.input.entries,
          content,
          db,
          group.input.products
        );
        note(entries);
      }
      const pending = await prepareControlPendingCommands(
        db,
        [group.input.input],
        mount,
        group.input.terminal ? [] : group.input.entries,
        entries,
        content
      );
      if (terminal) note(preparedControlTerminalEntries(terminal));
      freezes([group.input.input]);
      groups.push({ kind: 'pending', input: group.input, pending, terminal });
    } else if (group.kind === 'products') {
      const entries = await prepareControlEntries(
        owner,
        mount,
        group.transition.entries,
        content,
        db,
        group.transition.products
      );
      const pending = group.transition.pending?.length
        ? await prepareControlPendingCommands(
            db,
            group.transition.pending,
            mount,
            group.transition.entries,
            entries,
            content
          )
        : undefined;
      note(entries);
      freezes(group.transition.pending ?? []);
      groups.push({ kind: 'products', transition: group.transition, entries, pending });
    } else if (group.kind === 'terminal') {
      const terminal = await prepareControlTerminal(db, group.input, mount, content, carried);
      note(preparedControlTerminalEntries(terminal));
      groups.push({ kind: 'terminal', input: group.input, terminal });
    } else {
      const append = await prepareControlItemAppend(db, group.input, mount);
      const turnId = append.item.turnId!;
      if (append.replay) {
        groups.push({
          kind: 'item',
          turnId,
          headRevision: append.head.revision,
          headRecord: append.head.record,
        });
      } else {
        const body = await prepareRetainedProductJson(
          mount,
          owner,
          join(dirname(dirname(db.sqlite.name)), 'runtime', 'staging'),
          writeRetainedV1(append.item)
        );
        // A later Item on the same Turn follows the Items earlier groups append to it.
        const entry: ControlProductEntry = {
          kind: 'item',
          turnId,
          sequence: Math.max(append.sequence, (plannedSequence.get(turnId) ?? 0) + 1),
          expectedRevision: append.revision,
          ...body,
        };
        if (['pending', 'running'].includes(String(append.head.record.status))) {
          const entries = await prepareControlEntries(owner, mount, [entry], content);
          note(entries);
          groups.push({
            kind: 'item',
            turnId,
            headRevision: append.head.revision,
            headRecord: append.head.record,
            entries,
          });
        } else {
          const input: ControlPublicationInput = {
            category: group.input.category!,
            turnId,
            expectedRevision: append.head.revision,
            entries: [entry],
          };
          const prepared = await prepareControlPublication(db, input, mount, content);
          note(preparedControlPublicationEntries(prepared));
          groups.push({
            kind: 'item',
            turnId,
            headRevision: append.head.revision,
            headRecord: append.head.record,
            publication: { input, prepared },
          });
        }
      }
    }
    carried = [];
  }
  if (carried.length) throw new ControlProductPreconditionError();
  return {
    workspaceId: header.workspaceId,
    operation: header.operation,
    threadId: header.threadId,
    inputs: header.inputs,
    groups,
    content,
  };
}

/**
 * Decides one prepared plan inside its single rollback boundary: one complete input recheck, then
 * each owner's own decision in order on the state the preceding groups produced. Only after the
 * last group passes does it publish the deferred names and synchronize their directories, before
 * the caller's FULL COMMIT. Any refusal leaves no row and no new name.
 */
export function applyControlPendingPlan(
  db: WorkspaceDb,
  owner: ControlProductOwner,
  prepared: PreparedControlPendingPlan
): ControlPendingCommandResult {
  if (!db.sqlite.inTransaction || prepared.workspaceId !== db.workspaceId)
    throw new ControlProductPreconditionError();
  try {
    // Inside one rollback boundary the recheck's place decides only which refusal is reported. A
    // Boot group refuses any changed input first, as its Workspace records; a live closeout lets
    // each owner report its own typed refusal first, then refuses an input no owner rechecks.
    const unchanged =
      controlPendingPlanInputs(db.sqlite, db.workspaceId, prepared.threadId) === prepared.inputs;
    if (prepared.operation === 'pending-boot' && !unchanged)
      throw new ControlProductPreconditionError();
    return decideControlPendingPlan(db, owner, prepared, unchanged);
  } catch (error) {
    // A refused decision links nothing; its private bodies are removed with its rolled-back rows.
    discardStagedFiles(prepared.content.deferred);
    throw error;
  }
}

/** Each owner's own decision in order, the closeout recheck, then the deferred names. */
function decideControlPendingPlan(
  db: WorkspaceDb,
  owner: ControlProductOwner,
  prepared: PreparedControlPendingPlan,
  unchanged: boolean
): ControlPendingCommandResult {
  const requestIds: string[] = [];
  for (const group of prepared.groups) {
    if (group.kind === 'pending') {
      const result = applyControlPendingTransition(
        db,
        group.input,
        withWorkerInputs(db, [group.input.input], group.pending),
        group.terminal
      );
      requestIds.push(...result.requestIds);
    } else if (group.kind === 'products') {
      applyControlProducts(db.sqlite, owner, group.transition.products, group.entries);
      const pending = withWorkerInputs(
        db,
        group.transition.pending ?? [],
        group.pending ?? { entries: [], dependencies: [] }
      );
      for (const command of group.transition.pending ?? [])
        requestIds.push(...applyControlPendingCommand(db, command, pending).requestIds);
    } else if (group.kind === 'terminal') {
      applyControlTerminal(db, group.input, group.terminal);
    } else {
      if (readProduct(db.sqlite, owner, 'turn', group.turnId)?.revision !== group.headRevision)
        throw new ControlProductPreconditionError();
      if (group.publication)
        applyControlPublication(db, group.publication.input, group.publication.prepared);
      else if (group.entries)
        applyControlProducts(
          db.sqlite,
          owner,
          [{ kind: 'turn', expectedRevision: group.headRevision, record: group.headRecord }],
          group.entries
        );
    }
  }
  if (prepared.operation === 'pending-closeout' && !unchanged)
    throw new PendingRequestCommandError(
      'conflict',
      'The Pending closeout changed after it was planned.',
      409
    );
  linkStagedFiles(prepared.content.deferred, prepared.content.directories);
  return { requestIds: [...new Set(requestIds)], applied: null, created: null };
}

/** Derives each Worker freeze's input batch from the rows its earlier groups produced. */
function withWorkerInputs(
  db: WorkspaceDb,
  commands: readonly ControlPendingCommandInput[],
  prepared: PreparedControlPendingCommand
): PreparedControlPendingCommand {
  const workerInputs = new Map(prepared.workerInputs ?? []);
  for (const command of commands) {
    if (command.action !== 'freeze' || command.executor !== 'worker') continue;
    const selected = command.expectedSelection.map((requestId) => {
      const record = readPendingRequest(db.sqlite, requestId);
      if (!record) throw new ControlProductPreconditionError();
      return record;
    });
    const batch = pendingOutcomeBatchDraft(command, selected);
    if (batch)
      workerInputs.set(command.turnId, {
        manifest: batch.manifest.input,
        prepared: prepareWorkspaceQueueInputBatch(db, batch),
      });
  }
  return workerInputs.size ? { ...prepared, workerInputs } : prepared;
}
