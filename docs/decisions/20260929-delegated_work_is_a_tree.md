---
status: Accepted
date: "2026-09-29"
decider: Engineer
---
# Delegated Work Is A Tree, Not A Mesh

## Decision

Control over delegated work is a tree, orchestrated in NanoCore. The nodes are Threads and the edges are delegations. A control edge, such as dispatching work, answering a pending request, or cancelling, runs only between a parent and its child. Worker execution is always a leaf: a worker gets no tool to spawn Threads, start other workers, or send control to a sibling. Each scope has one orchestrator that creates and cancels child work and answers its requests, and today that orchestrator is a person in Task Mode. What separates a tree from a mesh is which destinations and which authority NanoCore admits, not the shape of a message. A read-only view of peers creates no control edge, so it does not break the tree.

## Reason

The engineer's reasoning, translated from Chinese: letting Threads message each other, or letting a worker spawn another Thread on its own, can lead to spawns outside OpenKit's control, and even to explosive spawning or infinite loops. Orchestration is kept in NanoCore as a tree so that users understand how the work is structured and progressing, manage it more easily, and carry less mental burden, and so that OpenKit avoids the rising cost, falling efficiency, poor manageability, and instability of an agent mesh or graph.

Agent analysis, supporting the ruling: the tree bounds depth structurally, because a worker cannot dispatch. It rules out cycles, because a parent is fixed when the child is created and must already exist. It removes the need for depth or fan-out counters. A worker's native subagents inside one Turn remain private provenance, not nodes, and stay bounded only by the Turn lease and Gateway budgets.

Source: the 2026-09-29 working session recorded in the agent communication redesign change record.

## Rejected Alternatives

- **A worker-callable spawn tool.** Rejected as the uncontrolled spawning the engineer described. Supporting it safely would need new depth and fan-out mechanisms, and the tree removes that need.
- **Direct sibling messaging or steering a running Turn.** Rejected because it forms a mesh and a second writer into a running Turn.
- **Orchestration tools inside the Sandbox, or routing messages in Sandbox Integration.** Rejected because the orchestrator is not in the Sandbox, and records and attribution would fall inside the shared compromise domain.

## Revisit When

A product need requires a node to control work outside its own subtree, or the Goal redesign makes an agent the orchestrator of a scope.

## Affected Owners

- docs/core/agent-workflow.md
- docs/core/communication.md
- docs/specs/20260704-task_mode_worker_delegation.md
- docs/specs/20260703-worker_agent_capability.md
