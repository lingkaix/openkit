import { describe, expect, it } from 'vitest';

import { createDeterministicGoalPlanFallback, GoalPlanOutputSchema } from './goal-plan.js';

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
