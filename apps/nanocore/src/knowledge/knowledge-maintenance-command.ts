import { KnowledgeMaintenanceResponseSchema } from '@openkit/app-api-schemas';
import { OperationError } from '../operation-error.js';
import { commandInputHash, runIdempotentCommand } from '../runtime/idempotent-command.js';
import { type KnowledgeMaintenanceDependencies, type KnowledgeMaintenanceInput,
  prepareKnowledgeMaintenance } from './knowledge-agent-maintenance.js';

/**
 * Uses the existing command receipt to return one maintenance Turn without repeating model work.
 *
 * The receipt points to the admitted Turn before inference. A missing terminal result remains inspect-only; it cannot authorize another run. Accepted native outcomes stay on the existing Status or completed Tool-call Item.
 */
export async function runKnowledgeMaintenanceCommand(
  dependencies: KnowledgeMaintenanceDependencies, input: KnowledgeMaintenanceInput
) {
  const command = input.tellContent === undefined ? 'knowledge.maintain' : 'knowledge.tell';
  const scope = { workspaceId: input.workspaceId, actorId: input.actor.id };
  const canonicalInput = { workspaceId: input.workspaceId, instructions: input.instructions,
    sources: input.sources, tellContent: input.tellContent,
    askingThreadId: input.askingThreadId, askingTurnId: input.askingTurnId };
  const workspaceDb = dependencies.openWorkspace(input.workspaceId);
  try {
    return await runIdempotentCommand({
      store: dependencies.store, inflightCommands: dependencies.inflightCommands, command,
      requestId: input.requestId, scope, input: canonicalInput, workspaceDb,
      responseKind: 'turn', responseId: (result) => result.turnId,
      execute: async () => {
        const prepared = prepareKnowledgeMaintenance(dependencies, input);
        dependencies.store.recordCommandRequest({ command, requestId: input.requestId, scope,
          inputHash: commandInputHash(canonicalInput), response: { kind: 'turn', id: prepared.turnId } }, workspaceDb);
        return prepared.execute();
      },
      replay: (receipt) => {
        const turn = dependencies.store.getTurnById(receipt.response.id);
        if (turn.workspaceId !== input.workspaceId || turn.agentId !== 'knowledge-manager')
          throw new OperationError('recovery_required', 'Knowledge maintenance requires inspection.', 409);
        const retained = turn.items.findLast((item) => item.type === 'status' && item.knowledgeMaintenanceResult);
        if (retained?.type === 'status') return KnowledgeMaintenanceResponseSchema.parse(retained.knowledgeMaintenanceResult);
        for (const item of turn.items.toReversed()) {
          if (item.type !== 'tool-call' || item.tool !== 'knowledge.notebook.update' || item.status !== 'completed' || !item.result) continue;
          const parts = JSON.parse(item.result) as Array<{ type: string; text?: string }>;
          for (const part of parts) {
            if (part.type !== 'text' || !part.text) continue;
            const result = KnowledgeMaintenanceResponseSchema.safeParse(JSON.parse(part.text));
            if (result.success) return result.data;
          }
        }
        const base = turn.internalExecution?.knowledge?.baseRevision;
        if ((turn.status === 'failed' || turn.status === 'cancelled') && base && turn.error)
          return KnowledgeMaintenanceResponseSchema.parse({ threadId: turn.threadId, turnId: turn.id,
            outcome: 'failed', notebookRevision: base, summary: turn.error.message });
        throw new OperationError('recovery_required', 'The admitted Knowledge maintenance Turn has no settled result. Inspect it; use a new request for new work.', 409);
      },
    });
  } finally { workspaceDb.sqlite.close(); }
}
