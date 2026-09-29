---
status: Accepted
date: "2026-09-29"
decider: Engineer
---
# AgentSession Is One Active Execution Binding, Independent Of Turns

## Decision

A Thread is the persistent user conversation and work context, with its retained native conversation. It has at most one current authoritative AgentSession. An AgentSession binds one authorized active execution of that native conversation on one admitted runtime host instance, which may be a dedicated conversation process or a native conversation hosted in a shared server.
- Sequential Turns use the same binding, and a completed Turn leaves it available.
- Closing an AgentSession stops its work and releases its binding, while preserving native context and work files. A dedicated process is terminated; a shared server stays available to other AgentSessions.
- Temporary transport loss can reconnect to the same surviving instance without replacing the AgentSession.
- Work resumed after closure uses a new AgentSession, which reopens the exact retained conversation through the runtime's native resume. Native resume failure is explicit, and a new empty conversation or a reconstruction from messages never silently replaces it.

## Reason

The engineer approved this model on 2026-09-29 in the lifecycle proposal, and refined it by noting that Codex and OpenCode host multiple conversations in one shared server. In Round 13 on 2026-09-30 the engineer restated it, translated from Chinese: the proposal solves the problem that the current design binds AgentSessions, process lifetime, and per-Turn delivery too tightly, which is an unreasonable design; AgentSession has been redesigned and is no longer bound to Turns. In Round 15 the engineer added that the old flow, in which approval required starting a new Task, came from that tight binding and was unreasonable.

Agent analysis, from the lifecycle proposal: the old binding forced a runtime restart after every reply, and it made human decisions close the AgentSession and require a new Task.

## Rejected Alternatives

- Keeping AgentSession across process restarts as a logical conversation, rejected because the Thread and its retained native conversation already carry that continuity, while an execution binding gives a clear scope for authority, fault attribution, and cleanup.
- Binding AgentSession to each Turn, rejected because it keeps unnecessary restarts.
- Making every network disconnect terminal, rejected because it creates avoidable failures.
- Rebuilding context from the visible transcript, rejected because it loses native state while presenting a misleading continuation.

## Revisit When

A supported runtime cannot keep a live context between Turns or resume an exact retained conversation, or a native conversation must move between runtime kinds.

## Affected Owners

- docs/core/agent-session.md
- docs/core/runtime-model.md
- docs/specs/20260704-agent_session_continuity.md
- docs/specs/20260629-worker_runtime_communication_model.md
- docs/specs/20260703-worker_control_protocol.md
