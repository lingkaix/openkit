import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TurnSchema } from '@openkit/protocol';
import { z } from 'zod';
import type { FsStore } from '../lib/store.js';

type Turn = z.infer<typeof TurnSchema>;

/**
 * Turn feedback rating schema.
 */
export const TurnFeedbackRatingSchema = z.enum(['good', 'bad']).nullable();

/**
 * Turn feedback schema persisted on disk.
 */
export const TurnFeedbackSchema = z
  .object({
    createdAt: z.string().min(1),
    note: z.string().nullable(),
    rating: TurnFeedbackRatingSchema,
    turnId: z.string().min(1),
    agentId: z.string().min(1).nullable(),
  })
  .strict();

/**
 * Turn feedback update request schema.
 */
export const UpdateTurnFeedbackRequestSchema = z
  .object({
    note: z.string().nullable(),
    rating: TurnFeedbackRatingSchema,
  })
  .strict();

/**
 * Persisted turn feedback.
 */
export type TurnFeedback = z.infer<typeof TurnFeedbackSchema>;

/**
 * Turn feedback update input.
 */
export type UpdateTurnFeedbackInput = z.infer<typeof UpdateTurnFeedbackRequestSchema>;

/**
 * Returns the feedback file path for one turn.
 *
 * @param store Store that owns the turn.
 * @param turn Turn record.
 * @returns Feedback file path.
 * @throws Error when the store is not file-backed.
 */
export function feedbackFilePath(store: FsStore, turn: Turn): string {
  const dataRoot = store.getDataRoot();

  if (!dataRoot) {
    throw new Error('Turn feedback requires a file-backed data root.');
  }

  return join(
    dataRoot,
    'users',
    store.getUserId(),
    'workspaces',
    turn.workspaceId,
    'threads',
    turn.threadId,
    'turns',
    turn.id,
    'feedback.json'
  );
}

/**
 * Creates the initial feedback file for a completed turn when missing.
 *
 * @param store Store that owns the turn.
 * @param turn Completed turn record.
 * @param agentId Agent id selected for the turn.
 * @returns Feedback record, or null for in-memory stores.
 */
export function ensureTurnFeedback(
  store: FsStore,
  turn: Turn,
  agentId: string | null
): TurnFeedback | null {
  if (!store.getDataRoot()) {
    return null;
  }

  const path = feedbackFilePath(store, turn);

  if (existsSync(path)) {
    return readFeedbackFile(path);
  }

  const feedback: TurnFeedback = {
    createdAt: new Date().toISOString(),
    note: null,
    rating: null,
    turnId: turn.id,
    agentId,
  };

  writeFeedbackFile(path, feedback);
  return feedback;
}

/**
 * Reads feedback for a turn.
 *
 * @param store Store that owns the turn.
 * @param turnId Turn id.
 * @returns Feedback record.
 */
export function readTurnFeedback(store: FsStore, turnId: string): TurnFeedback {
  return readFeedbackFile(feedbackFilePath(store, store.getTurnById(turnId)));
}

/**
 * Atomically updates feedback for a turn.
 *
 * @param store Store that owns the turn.
 * @param turnId Turn id.
 * @param input Feedback update.
 * @returns Updated feedback record.
 */
export function updateTurnFeedback(
  store: FsStore,
  turnId: string,
  input: UpdateTurnFeedbackInput
): TurnFeedback {
  const turn = store.getTurnById(turnId);
  const existing =
    store.getDataRoot() && existsSync(feedbackFilePath(store, turn))
      ? readTurnFeedback(store, turnId)
      : ensureTurnFeedback(store, turn, store.resolveTurnAgentId(turn));

  if (!existing) {
    throw new Error('Turn feedback requires a file-backed data root.');
  }

  const updated: TurnFeedback = {
    ...existing,
    note: input.note,
    rating: input.rating,
  };

  writeFeedbackFile(feedbackFilePath(store, turn), updated);
  return updated;
}

/**
 * Reads and validates one feedback file.
 *
 * @param path Feedback file path.
 * @returns Feedback record.
 */
function readFeedbackFile(path: string): TurnFeedback {
  return TurnFeedbackSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/**
 * Writes feedback using a temp file and rename.
 *
 * @param path Feedback file path.
 * @param feedback Feedback record.
 */
function writeFeedbackFile(path: string, feedback: TurnFeedback): void {
  mkdirSync(dirname(path), { recursive: true });

  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;

  writeFileSync(tempPath, `${JSON.stringify(feedback, null, 2)}\n`);
  renameSync(tempPath, path);
}
