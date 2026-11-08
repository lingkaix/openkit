import {
  GitFailureExplanationSchema,
  ProductTurnSchema,
  type TurnErrorPresentation,
  TurnErrorPresentationSchema,
} from '@openkit/protocol';

type ErrorClass = TurnErrorPresentation['class'];
/** Closed meanings of currently recognized product codes; unknown and ambiguous codes stay neutral. */
export const TURN_ERROR_CODE_CLASSES: Readonly<Record<string, ErrorClass>> = Object.freeze({
  tests_failed: 'work',
  test_failed: 'work',
  command_failed: 'work',
  work_failed: 'work',
  turn_cancelled: 'work',
  worker_governance_turn_cancelled: 'work',
  internal_agent_aborted: 'work',
  provider_call_aborted: 'work',
  internal_agent_model_turns_limit: 'work',
  internal_agent_tool_calls_limit: 'work',
  internal_agent_deadline_limit: 'work',
  provider_call_failed: 'system',
  chat_provider_failed: 'system',
  internal_inference_failed: 'system',
  internal_gateway_call_failed: 'system',
  provider_response_invalid: 'system',
  provider_stream_failed: 'system',
  provider_stream_truncated: 'system',
  gateway_stream_failed: 'system',
  worker_inference_stream_failed: 'system',
  worker_preparation_failed: 'system',
  task_admission_failed: 'system',
  git_fetch_failed: 'system',
  git_fetch_tls_failed: 'system',
  git_fetch_transport_failed: 'system',
  internal_agent_summary_invalid: 'system',
  internal_agent_context_unavailable: 'system',
  internal_agent_empty_answer: 'system',
  knowledge_manager_timeout: 'system',
  knowledge_maintenance_unavailable: 'system',
  memory_maintenance_unavailable: 'system',
  memory_forget_prepare_failed: 'system',
  agent_not_configured: 'needs-you',
  agent_not_found: 'needs-you',
  workspace_access_denied: 'needs-you',
  policy_denied: 'needs-you',
  policy_requires_approval: 'needs-you',
  policy_requires_escalation: 'needs-you',
  credential_binding_unavailable: 'needs-you',
  unsupported_gateway_feature: 'needs-you',
  gateway_logical_model_unavailable: 'needs-you',
  git_fetch_http_refused: 'needs-you',
  internal_agent_context_exceeded: 'needs-you',
  internal_agent_context_deadline: 'needs-you',
  delivery_unknown: 'unknown-outcome',
  outcome_unknown: 'unknown-outcome',
  recovery_required: 'unknown-outcome',
  core_restarted: 'unknown-outcome',
  workspace_recovered: 'unknown-outcome',
  worker_governance_restart_recovery: 'unknown-outcome',
  worker_governance_turn_failed: 'unclassified',
  goal_coordinator_failed: 'unclassified',
  knowledge_query_failed: 'unclassified',
  knowledge_manager_failed: 'unclassified',
  knowledge_maintenance_failed: 'unclassified',
});

const summaries: Record<ErrorClass, string> = {
  work: 'This run stopped before finishing its work. Inspect the recorded result.',
  system: 'OpenKit could not finish this run because a system operation failed.',
  'needs-you': 'Current access or setup needs your attention. Inspect the recorded reason.',
  'unknown-outcome':
    'OpenKit could not confirm this run’s outcome. Inspect recorded effects before starting new work.',
  unclassified: 'This run ended with an error.',
};

/** Descriptive projection only. The authorized source owner supplies actions; classification never grants retry. */
export function projectTurnErrorPresentation(
  error: { readonly code: string | null; readonly message: string; readonly explanation?: unknown },
  ownerActions: TurnErrorPresentation['actions'] = []
): TurnErrorPresentation {
  let classification =
    error.code !== null && Object.hasOwn(TURN_ERROR_CODE_CLASSES, error.code)
      ? TURN_ERROR_CODE_CLASSES[error.code]!
      : 'unclassified';
  // Only the original typed observation refines an ambiguous worker category.
  // An unknown effect outcome always keeps precedence over a failure origin.
  if (error.code === 'worker_governance_turn_failed') {
    const observation = GitFailureExplanationSchema.safeParse(error.explanation);
    if (observation.success) classification = TURN_ERROR_CODE_CLASSES[observation.data.code]!;
  }
  return TurnErrorPresentationSchema.parse({
    class: classification,
    summary: summaries[classification],
    actions: classification === 'unclassified' ? [] : ownerActions,
  });
}

/** Exact read action returned only by an already admitted Workspace Turn surface. */
export function turnErrorInspectAction(input: {
  workspaceId: string;
  threadId: string;
  turnId: string;
}): TurnErrorPresentation['actions'] {
  return [{ kind: 'inspect', owner: 'turn', operation: 'turn.read', input }];
}

/** Projects only after the caller admits this exact Turn; retained code, message and bytes stay with their original owner. */
export function projectProductTurn(value: unknown) {
  // A retained additive annotation is never a server-authored classification.
  if (
    value &&
    typeof value === 'object' &&
    'error' in value &&
    value.error &&
    typeof value.error === 'object'
  ) {
    const { presentation: _annotation, ...error } = value.error as Record<string, unknown>;
    value = { ...value, error };
  }
  const turn = ProductTurnSchema.parse(value);
  if (!turn.error) return turn;
  return {
    ...turn,
    error: {
      ...turn.error,
      presentation: projectTurnErrorPresentation(
        turn.error,
        turn.owner.kind === 'workspace'
          ? turnErrorInspectAction({
              workspaceId: turn.owner.workspaceId,
              threadId: turn.threadId,
              turnId: turn.id,
            })
          : []
      ),
    },
  };
}
