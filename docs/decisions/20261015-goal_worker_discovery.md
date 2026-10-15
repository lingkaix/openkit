---
status: Accepted
date: "2026-10-15"
decider: Coordinator under engineer delegation
---
# Goal Worker Discovery Ruling

## Decision

Admit one fixed read-only projection of canonical `agent.list` for the Goal Coordinator. The [Goal owner](../specs/20261002-goal.md#worker-discovery) defines its strict empty model input, bound authority, one-Workspace content-read boundary, safe candidate projection, current checks, failures, and acceptance. Existing Agent Supply, Task eligibility, Workflow Coordinator candidate values, and operation invocation retain their authority. Discovery adds no grant, pin, durable catalog, Worker control, or runtime.

## Reason

### Source And Acceptance

The coordinator commissioned this owner amendment through P07-142-owner-request.md in the backlog-20261015 working record. The engineer's engineer-rulings-20261015.md, Confirmation and expanded delegation, permits other decisions and designs with independent Astra agreement unless a major blocker or key authorization needs the engineer. This is delegated acceptance, not direct engineer approval of the exact amendment.

Independent Astra scrutiny in backlog-20261015/reviews/P11-142-consultant.md agreed with the bounded route and returned Continue. The accepted text incorporates all five corrections: canonical operation identity; Workspace restriction before content reads; qualified candidate reuse; truthful incomplete/failed reads; and exact Plan approval plus authority, audience, input, and immutable-assembly acceptance checks. The Consultant identified no major blocker or key authorization while discovery remains within current Goal authority.

### Evidence And Reason

P07's probe source and output are p07-142-probe.mts and p07-142-probe.json at source head `e740bafb981dab57a38a25c23035cd66e8fdfed3`. Production App assembly supplied no Agent discovery Tool, required `task_start.agentId`, and allowed the same actor's catalog read. Scripted Gateway replies created an ordinary card and completed Coordinator Turns. They neither approved a Plan nor requested Task admission. Zero Tasks does not establish a historical failure cause, readiness, what a live model would choose, or real Worker delivery.

The Goal owner permits Worker selection and ordinary Task admission but lacked this discovery contract. One on-demand read supplies candidate information through existing owners and can refresh it during a bounded run. Catalog presence does not prove readiness. The current general catalog operation's wider authorized scope and the current helper's missing runtime label, forwarded reasons, and missing-readiness default do not prove this narrower contract. Implementation must reconcile those facts through P07/P12/P13's existing seams.

## Rejected Alternatives

- Default-only selection avoids discovery but gives less selection control.
- Preloading candidates provides one snapshot without an explicit refresh during the run.
- A separate catalog or selection algorithm duplicates an existing authority and is unnecessary.
- Requiring a person to supply an internal Agent identity leaves the requested ordinary Goal workflow incomplete.

## Revisit When

This decision accepts the bounded owner contract, not implementation or closure of #142. Exact Task admission still follows approval and activation of the exact Plan and all current Task checks. Assembly/admission evidence remains separate from real Worker delivery and completion.

The next useful implementation observation is an actor authorized for two Workspaces whose Goal discovery reads candidate content from only its own Workspace. Broader access, weaker readiness checks, or added effects require renewed direction scrutiny and the relevant owner decision.

## Affected Owners

- [Goal](../specs/20261002-goal.md)
- [Agent Supply](../core/agent-supply.md)
- [Workflow Coordinator](../specs/20260704-workflow_coordinator_internal_agent.md)
- [Operation Definition](../specs/20261002-operation_definition.md)
- [Internal Agent Resource Integration](../specs/20260909-internal_agent_resource_integration.md)
