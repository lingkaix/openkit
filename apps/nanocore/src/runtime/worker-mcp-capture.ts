import { resolve } from 'node:path';
import type { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';

/** The Gateway remains the physical process/close owner; these are its capture joins. */
interface McpCaptureParticipant {
  hasWorkspaceData(workspaceId?: string): boolean;
  stopWorkspace(workspaceId: string): Promise<void>;
}
interface OriginalMcpCall {
  workspaceId: string;
  done: Promise<void>;
  releaseAdmission: (() => void) | null;
}
interface McpCaptureRoot {
  admission?: WorkspaceMutationAdmission;
  participants: Set<McpCaptureParticipant>;
  calls: Set<OriginalMcpCall>;
}
const roots = new Map<string, McpCaptureRoot>();

function rootFor(dataRoot: string): McpCaptureRoot {
  const key = resolve(dataRoot);
  let root = roots.get(key);
  if (!root) {
    root = { participants: new Set(), calls: new Set() };
    roots.set(key, root);
  }
  return root;
}

/** Binds the same application gate, including original standalone calls begun before binding. */
export function bindMcpCaptureAdmission(
  dataRoot: string,
  admission: WorkspaceMutationAdmission
): void {
  const root = rootFor(dataRoot);
  if (
    root.admission &&
    root.admission !== admission &&
    (root.calls.size !== 0 ||
      [...root.participants].some((participant) => participant.hasWorkspaceData()))
  )
    throw new Error('MCP Workspace mutation owner changed.');
  root.admission = admission;
  for (const call of root.calls) {
    call.releaseAdmission ??= admission.enterLatePublisher(call.workspaceId, 'mcp-workspace-data');
  }
}

/** Registration lasts through the original Gateway's successful physical teardown, not a timeout. */
export function registerMcpCaptureParticipant(
  dataRoot: string,
  participant: McpCaptureParticipant
): () => void {
  const root = rootFor(dataRoot);
  root.participants.add(participant);
  return () => {
    root.participants.delete(participant);
  };
}

/** Reserves the original complete exchange before it can create canonical files or spawn. */
export function enterMcpCaptureCall(dataRoot: string, workspaceId: string): (() => void) | null {
  const root = rootFor(dataRoot);
  const releaseAdmission =
    root.admission?.enterLatePublisher(workspaceId, 'mcp-workspace-data') ?? null;
  if (root.admission && !releaseAdmission) return null;
  const settled = Promise.withResolvers<void>();
  const call: OriginalMcpCall = { workspaceId, done: settled.promise, releaseAdmission };
  root.calls.add(call);
  return () => {
    if (!root.calls.delete(call)) return;
    call.releaseAdmission?.();
    settled.resolve();
  };
}

/** Reads only current Gateway-owned resources/calls, never a filesystem or all-writer census. */
export function hasWorkspaceMcpData(dataRoot: string, workspaceId: string): boolean {
  const root = roots.get(resolve(dataRoot));
  return (
    !!root &&
    ([...root.calls].some((call) => call.workspaceId === workspaceId) ||
      [...root.participants].some((participant) => participant.hasWorkspaceData(workspaceId)))
  );
}

/** Existing gate closure prevents new calls; join originals, then prove every original group closed. */
export async function quiesceWorkspaceMcpData(
  dataRoot: string,
  workspaceId: string
): Promise<void> {
  const root = roots.get(resolve(dataRoot));
  if (!root) return;
  await Promise.all(
    [...root.calls].filter((call) => call.workspaceId === workspaceId).map((call) => call.done)
  );
  const stopped = await Promise.allSettled(
    [...root.participants].map((participant) => participant.stopWorkspace(workspaceId))
  );
  const errors = stopped
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);
  if (errors.length) throw new AggregateError(errors, 'MCP Workspace stop is unconfirmed.');
}
