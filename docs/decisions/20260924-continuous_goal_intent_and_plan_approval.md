---
status: Accepted
date: "2026-09-24"
decider: Engineer, on a Consultant-reviewed proposal
---
# Continuous Goal Intent And Plan Approval

## Decision

A Goal remains one continuous process while its user revises the objective, scope, and other intent. Planning occurs throughout that process, using the existing Goal, Thread, Turn, Plan, and human-attention owners. Every new immutable Plan version requires approval of the exact version; refinements wholly inside existing authorization are recorded as execution choices and may proceed without another Plan approval. A deliberate split or independently managed outcome may create a new Goal, but a material change alone does not require one. The Goal Mode Coordination and Workflow Coordinator specifications own the behavioral rules.

## Reason

The engineer wants users to improve, correct, and change a Goal while work proceeds, without forcing a new Goal for each change or repeatedly approving routine execution details. Approval must still cover meaningful changes in commitment or risk. A user's explicit instruction authorizes the requested intent change, while the resulting method, cost, permission, or external effect remains subject to its own approval and authority. Independent Consultant scrutiny rejected using unchanged fields as a sufficient materiality test and stopping all work whenever intent changes. This decision also supersedes the earlier premise in [A Failed Plan Revision Keeps The Goal Alive](20260921-plan_revision_failure_keeps_goal.md) that a recoverable initial planner failure must fail the Goal; the earlier record's revision-failure decision still applies.

## Rejected Alternatives

- Create a separate Planning workflow or durable Planning Session. Rejected because the existing Goal process and owners can carry continued planning.
- Require a new Goal for every material objective or scope change. Rejected because it breaks the continuity of a user's evolving objective.
- Require approval for every execution refinement. Rejected because already authorized details can be adjusted and recorded without a redundant gate.
- Treat an exact diff or unchanged acceptance and budget fields as sufficient proof that a revision is immaterial. Rejected because a changed method or risk can materially alter the commitment.
- Stop every active Task on any intent revision. Rejected because work that remains valid and authorized may continue.

## Revisit When

Observed misclassification of material revisions as refinements, or a demonstrated need that existing Goal owners cannot represent, warrants a narrower rule or a separately approved mechanism.

## Affected Owners

- docs/specs/20260704-goal_mode_coordination.md
- docs/specs/20260704-workflow_coordinator_internal_agent.md
