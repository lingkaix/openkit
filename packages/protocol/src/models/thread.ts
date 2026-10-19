import { z } from 'zod';

import { ThreadIdSchema, UserIdSchema } from '../common/ids.js';
import { TimestampSchema } from '../common/timestamps.js';
import { WorkOwnerSchema } from './work-owner.js';

/** Server-authored product entry that owns one Thread's continuation path. */
export const ThreadEntryPathSchema = z.enum([
  'conversation',
  'administration',
  'knowledge-manager',
]);

/**
 * A durable narrative with one immutable Workspace or Server owner.
 */
export const ThreadSchema = z
  .object({
    id: ThreadIdSchema,
    owner: WorkOwnerSchema,
    workspaceId: z.never().optional(),
    /** Immutable originating Thread of a separate receiving-Thread handoff. */
    parentThreadId: ThreadIdSchema.optional(),
    name: z.string().min(1).nullable(),
    preview: z.string().min(1),
    status: z.enum(['active', 'archived']),
    entryPath: ThreadEntryPathSchema,
    /** Missing on retained records whose inception owner did not record classification. */
    threadSource: z.enum(['conversation', 'worker']).optional(),
    visibility: z.enum(['private', 'workspace', 'server']),
    privateOwnerUserId: UserIdSchema.optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .superRefine((thread, context) => {
    if (thread.parentThreadId === thread.id) {
      context.addIssue({
        code: 'custom',
        path: ['parentThreadId'],
        message: 'A receiving Thread must differ from its parent.',
      });
    }
    if ((thread.visibility === 'private') !== (thread.privateOwnerUserId !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['privateOwnerUserId'],
        message: 'Private ownership is required exactly for private Threads.',
      });
    }
    if ((thread.owner.kind === 'server') !== (thread.visibility === 'server')) {
      context.addIssue({
        code: 'custom',
        path: ['visibility'],
        message: 'Visibility must agree with the immutable Thread owner.',
      });
    }
    if (
      thread.entryPath === 'administration' &&
      thread.owner.kind === 'workspace' &&
      thread.visibility !== 'private'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['visibility'],
        message: 'Administration Threads must be private.',
      });
    }
  });

/** Canonical narrative with an immutable owner. */
export type Thread = z.infer<typeof ThreadSchema>;
