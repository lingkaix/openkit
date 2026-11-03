import { assertControlProductWriter } from './control-store-products.js';
import type { CoreDb } from './db.js';
import {
  type ControlPrivateWorkspaceInput,
  ControlPrivateWorkspaceInputSchema,
} from './private-workspace-codecs.js';
import {
  bindPersonalWorkspaceInDb,
  recordWorkspaceOwnerMembership,
  reservePersonalWorkspaceInDb,
} from './workspace-owner-records.js';

/** Applies exactly one original Core stage inside the existing savepoint and covering FULL commit. */
export function applyControlPrivateWorkspaceInDb(
  core: CoreDb,
  raw: ControlPrivateWorkspaceInput
): string | null {
  assertControlProductWriter(core.sqlite);
  const input = ControlPrivateWorkspaceInputSchema.parse(raw);
  if (input.action === 'reserve') return reservePersonalWorkspaceInDb(core, input.userId);
  if (input.action === 'bind')
    bindPersonalWorkspaceInDb(
      core,
      input.userId,
      input.expectedWorkspaceId,
      input.workspaceId,
      new Date(input.at)
    );
  else
    recordWorkspaceOwnerMembership({
      coreDb: core,
      ownerUserId: input.userId,
      workspaceId: input.workspaceId,
      now: new Date(input.at),
    });
  return null;
}
