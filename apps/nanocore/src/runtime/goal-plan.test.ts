import { describe, expect, it } from 'vitest';

import {
  assertValidGoalPlanGraph,
  computeGoalPlanDigest,
  createDeterministicGoalPlanFallback,
  GoalPlanOutputSchema,
} from './goal-plan.js';

/**
 * Creates a valid Goal Mode plan output fixture.
 *
 * @returns Valid plan output input.
 */
function validPlanOutput(): unknown {
  return {
    schemaVersion: 1,
    goalSummary: 'Ship OpenKit v0.0.6 with a bounded Goal Mode loop.',
    assumptions: ['The workspace repository has already been linked.'],
    tasks: [
      {
        taskId: 'task_plan_schema',
        title: 'Define plan schema',
        objective: 'Add a bounded plan output schema for Goal Mode.',
        acceptanceCriteria: ['The schema accepts valid plans.', 'Invalid task shapes fail.'],
        contextBudgetTokens: 12_000,
        resources: [
          {
            kind: 'file',
            reference: 'apps/nanocore/src/runtime/goal-plan.ts',
            reason: 'Runtime schema implementation.',
          },
        ],
        expectedArtifacts: [
          {
            kind: 'code-change',
            description: 'A documented runtime schema and tests.',
          },
        ],
        verificationChecks: [
          {
            kind: 'test',
            description: 'Run the goal plan schema tests.',
            command:
              'pnpm --filter @openkit/nanocore exec vitest run src/runtime/goal-plan.test.ts',
          },
        ],
        reviewPolicy: {
          required: true,
          reviewers: ['human'],
          instructions: 'Review the schema before wiring planner output to storage.',
        },
        dependsOnTaskIds: [],
        escalationConditions: ['Escalate if the plan needs a protocol change.'],
      },
    ],
    risks: ['The schema could overfit the first planner implementation.'],
    questions: ['Should generated plans include verification commands by default?'],
    verificationApproach: 'Run focused schema tests before integrating Plan Mode.',
  };
}

describe('goal plan output schema', () => {
  it('accepts a valid bounded plan output', () => {
    const parsed = GoalPlanOutputSchema.parse(validPlanOutput());

    expect(parsed.goalSummary).toBe('Ship OpenKit v0.0.6 with a bounded Goal Mode loop.');
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0]).toMatchObject({
      taskId: 'task_plan_schema',
      contextBudgetTokens: 12_000,
      reviewPolicy: {
        required: true,
      },
    });
  });

  it('rejects planned tasks without acceptance criteria', () => {
    const invalid = validPlanOutput() as {
      tasks: Array<Record<string, unknown>>;
    };
    delete invalid.tasks[0]?.acceptanceCriteria;

    expect(() => GoalPlanOutputSchema.parse(invalid)).toThrow();
  });

  it('rejects planned tasks without context budget estimates', () => {
    const invalid = validPlanOutput() as {
      tasks: Array<Record<string, unknown>>;
    };
    delete invalid.tasks[0]?.contextBudgetTokens;

    expect(() => GoalPlanOutputSchema.parse(invalid)).toThrow();
  });

  it('rejects unknown fields and non-human reviewers', () => {
    const plan = validPlanOutput() as { tasks: Array<Record<string, unknown>> } & Record<
      string,
      unknown
    >;
    plan.unowned = true;
    expect(() => GoalPlanOutputSchema.parse(plan)).toThrow();

    delete plan.unowned;
    plan.tasks[0]!.reviewPolicy = {
      required: true,
      reviewers: ['worker'],
      instructions: 'Let the worker approve itself.',
    };
    expect(() => GoalPlanOutputSchema.parse(plan)).toThrow();
  });

  it('computes one canonical digest independent of object key order', () => {
    const plan = GoalPlanOutputSchema.parse(validPlanOutput());
    const reordered = {
      verificationApproach: plan.verificationApproach,
      questions: plan.questions,
      risks: plan.risks,
      tasks: plan.tasks,
      assumptions: plan.assumptions,
      goalSummary: plan.goalSummary,
      schemaVersion: plan.schemaVersion,
    };

    expect(computeGoalPlanDigest(plan)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(computeGoalPlanDigest(reordered)).toBe(computeGoalPlanDigest(plan));
    const orderedRisks = [...plan.risks, 'A second ordered risk.'];
    expect(computeGoalPlanDigest({ ...plan, risks: orderedRisks })).not.toBe(
      computeGoalPlanDigest({ ...plan, risks: [...orderedRisks].reverse() })
    );
  });

  it('keeps the digest stable after JSON storage omits optional undefined fields', () => {
    const input = validPlanOutput() as { tasks: Array<Record<string, unknown>> } & Record<
      string,
      unknown
    >;
    const plan = GoalPlanOutputSchema.parse({
      ...input,
      tasks: [
        {
          ...(input.tasks[0] ?? {}),
          verificationChecks: [
            {
              kind: 'manual',
              description: 'Review the stored result.',
              command: undefined,
            },
          ],
        },
      ],
    });
    const storedPlan = GoalPlanOutputSchema.parse(JSON.parse(JSON.stringify(plan)));

    expect(computeGoalPlanDigest(plan)).toBe(computeGoalPlanDigest(storedPlan));
  });

  it('rejects duplicate, self, missing, and cyclic dependencies', () => {
    const plan = GoalPlanOutputSchema.parse(validPlanOutput());
    const task = plan.tasks[0]!;

    expect(() => assertValidGoalPlanGraph([task, task])).toThrow(/duplicated/);
    expect(() => assertValidGoalPlanGraph([{ ...task, dependsOnTaskIds: [task.taskId] }])).toThrow(
      /itself/
    );
    expect(() =>
      assertValidGoalPlanGraph([{ ...task, dependsOnTaskIds: ['task_missing'] }])
    ).toThrow(/missing/);
    expect(() =>
      assertValidGoalPlanGraph([
        { ...task, dependsOnTaskIds: ['task_2'] },
        { ...task, taskId: 'task_2', dependsOnTaskIds: [task.taskId] },
      ])
    ).toThrow(/cycle/);
  });

  it('creates a deterministic fallback plan that validates against the plan schema', () => {
    const plan = createDeterministicGoalPlanFallback({
      goalTitle: 'Ship v0.0.6',
      objective: 'Make v0.0.6 ready to publish and use by end users.',
    });
    const parsed = GoalPlanOutputSchema.parse(plan);

    expect(parsed.goalSummary).toContain('Make v0.0.6 ready to publish');
    expect(parsed.assumptions).toContain('Deterministic fallback planner for test support.');
    expect(parsed.tasks.length).toBeGreaterThanOrEqual(1);
    expect(parsed.tasks[0]).toMatchObject({
      taskId: 'task_1',
      title: 'Ship v0.0.6',
      objective: 'Make v0.0.6 ready to publish and use by end users.',
      contextBudgetTokens: 12_000,
      reviewPolicy: {
        required: true,
        reviewers: ['human'],
      },
    });
  });

  it('keeps deterministic fallback strings within schema limits for long objectives', () => {
    const longObjective =
      'Verify that the a1 NanoCore server on port 54001 can run one bounded OpenShell local-container worker step for this OpenKit repository without modifying files, and report the evidence or precise blocker. '.repeat(
        20
      );

    const plan = createDeterministicGoalPlanFallback({
      goalTitle: longObjective,
      objective: longObjective,
    });

    expect(plan.goalSummary.length).toBeLessThanOrEqual(2_000);
    expect(plan.tasks[0].title.length).toBeLessThanOrEqual(200);
    expect(plan.tasks[0].objective.length).toBeLessThanOrEqual(2_000);
  });
});
