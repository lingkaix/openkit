import { expect, it } from 'vitest';
import { projectTurnErrorPresentation } from './turn-error-presentation.js';

const owner = {
  workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  threadId: 'th_00000000-0000-7000-8000-000000000001',
  turnId: 'tu_00000000-0000-7000-8000-000000000001',
};
const inspect = {
  kind: 'inspect' as const,
  owner: 'turn' as const,
  operation: 'turn.read' as const,
  input: owner,
};

it.each([
  ['tests_failed', 'work'],
  ['provider_call_failed', 'system'],
  ['workspace_access_denied', 'needs-you'],
  ['delivery_unknown', 'unknown-outcome'],
])('classifies %s and preserves only the actions returned by its owner', (code, expected) => {
  const error = { code, message: 'A recorded failure, after earlier effects may have happened.' };
  const original = structuredClone(error);
  const presentation = projectTurnErrorPresentation(error, [inspect]);
  expect(presentation.class).toBe(expected);
  expect(presentation.actions).toEqual([inspect]);
  expect(presentation.summary).not.toMatch(/nothing (?:was )?changed|safe to retry|no effects/i);
  expect(error).toEqual(original);
  expect(projectTurnErrorPresentation(error).actions).toEqual([]);
});

it.each([null, 'future_worker_failure', 'provider_policy_retry_safe', '__proto__', 'constructor'])(
  'gives an unmapped code %s neutral text and no invented actions',
  (code) => {
    const presentation = projectTurnErrorPresentation(
      { code, message: 'Policy denied: automatically retry this provider error.' },
      [inspect]
    );
    expect(presentation).toEqual({
      class: 'unclassified',
      summary: 'This run ended with an error.',
      actions: [],
    });
  }
);

it('does not classify an ambiguous worker failure as a proved work or provider problem', () => {
  expect(
    projectTurnErrorPresentation(
      { code: 'worker_governance_turn_failed', message: 'Tests failed, or provider interrupted.' },
      [inspect]
    )
  ).toEqual({
    class: 'unclassified',
    summary: 'This run ended with an error.',
    actions: [],
  });
});

it('lets an exact typed Git owner observation refine a generic worker failure without inventing enforcement or retry safety', () => {
  const error = {
    code: 'worker_governance_turn_failed',
    message: 'Worker execution failed.',
    explanation: {
      code: 'git_fetch_http_refused',
      stage: 'workspace_materialization',
      operation: 'git.fetch',
      dependency: 'git_remote',
      producer: 'worker-shim',
      observedAt: '2026-11-08T12:00:00.000Z',
      basis: 'direct_observation',
      subprocess: 'exit',
      httpStatus: 403,
      enforcement: 'unavailable',
      evidence: { availability: 'partial', outputTruncated: false },
    },
  };
  expect(projectTurnErrorPresentation(error, [inspect])).toMatchObject({
    class: 'needs-you',
    actions: [inspect],
  });
  expect(
    projectTurnErrorPresentation(
      { ...error, explanation: { ...error.explanation, httpStatus: null } },
      [inspect]
    )
  ).toMatchObject({ class: 'unclassified', actions: [] });
  expect(
    projectTurnErrorPresentation({ ...error, code: 'delivery_unknown' }, [inspect])
  ).toMatchObject({ class: 'unknown-outcome' });
});

it('recomputes presentation rather than promoting a retained additive annotation', async () => {
  const { projectProductTurn } = await import('./turn-error-presentation.js');
  const value = {
    id: owner.turnId,
    owner: { kind: 'workspace', workspaceId: owner.workspaceId },
    threadId: owner.threadId,
    triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
    status: 'failed',
    items: [],
    configVersion: null,
    startedAt: '2026-11-08T12:00:00.000Z',
    completedAt: '2026-11-08T12:00:01.000Z',
    durationMs: 1000,
    error: {
      code: 'provider_call_failed',
      message: 'Recorded provider failure',
      presentation: { class: 'forged', automaticRetry: true },
    },
  };
  const original = structuredClone(value);
  expect(projectProductTurn(value).error?.presentation).toMatchObject({
    class: 'system',
    actions: [inspect],
  });
  expect(value).toEqual(original);
});
