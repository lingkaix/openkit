# Web Product Surface Projection

Status: Accepted
Implementation: Implemented

## Summary

The Web UI is an important OpenKit product surface, but it must be a projection of stable NanoCore contracts rather than the place where kernel semantics are invented.

The Web UI should be built against stable NanoCore App API, protocol schemas, Agent Workflow, Action Center, workspace synchronization review/apply, Knowledge Store, permission, audit, vault, agent capability, runtime placement, and evidence contracts.

The superseded Web UI slice specs are retained as historical reference only. They may be mined for useful interaction details, but they do not define active product requirements.

## Owns

- The Web UI posture as a product surface over NanoCore and App API contracts.
- The minimum product areas future Web work must project when the underlying contracts stabilize.
- The boundary between user-facing Web presentation and core runtime, workflow, storage, permission, capability, and knowledge semantics.
- The current implementation projection of the Solid SPA.
- The status of older Web UI slice specs as historical reference.

## Does Not Own

- Core workflow semantics, Goal Mode mechanisms, worker execution, agent sessions, runtime placement, or scheduling.
- App API route design, protocol schemas, storage tables, worker-control routes, or capability gateway semantics.
- Knowledge Store governance, vault semantics, permission policy, audit storage, or workspace synchronization records.
- Detailed Web UI interaction design, component architecture, copy, route structure, or visual design.
- Release readiness gates.

## Core References

- `docs/core/work-model.md`
- `docs/core/agent-workflow.md`
- `docs/core/architecture.md`
- `docs/core/agent-capability.md`
- `docs/core/knowledge.md`
- `docs/core/permissions.md`
- `docs/core/audit.md`
- `docs/core/vault.md`

## Goals

- Keep the Web UI subordinate to stable NanoCore behavior, not the starting point for kernel semantics.
- Preserve useful historical UI details without keeping old slice specs active.
- Define the minimum contract-backed product areas for future Web UI planning.
- Keep Web features traceable to App API, protocol, core docs, or active specs.
- Avoid UI-only concepts that bypass item-backed work history, Action Center, review, audit, or evidence records.

## Non-goals

- Do not treat superseded Web slice specs as accepted current UX requirements.
- Do not define detailed UI layouts, component APIs, visual design, or copy.
- Do not use Web UI work as the default starting point for new kernel semantics.
- Do not make Web UI route or state shape the canonical product model.

## Projection Contract

The Web UI should expose the same product semantics already proven through NanoCore and agent-facing public APIs:

- workspace, repository, and source readiness
- thread and item history
- Agent Workflow surfaces such as Goal Mode plan, step, review, steering, redo, handoff, and closeout state
- Action Center rows
- artifact and evidence review
- workspace synchronization reviews and apply results
- Knowledge Store pages, proposals, source references, and context-package traces
- agent catalog, setup readiness, agent sessions, runtime placement, worker readiness, and worker diagnostics
- audit, permission, vault, metering, and usage views as those contracts stabilize
- provider, LLM gateway, MCP, Skill, and agent capability diagnostics

Product surfaces may group, filter, summarize, or visualize these records, but the underlying source of truth remains NanoCore state and App API responses. Web routes, local component state, UI-only filters, and browser storage are presentation projections, not canonical product records.

## Current Implementation Projection

The current Web implementation is a contract projection surface:

- `apps/web` is a Solid SPA used to validate workspace protocol and product UI.
- The app already covers workspace selection and configuration, thread and turn workflow, live streaming items, approvals, unified Human Attention Action Center, artifacts, agent session visibility, Goal Mode surfaces, Codex ChatGPT subscription login controls, LLM Gateway diagnostics, runtime config editing, and protocol inspection mode.
- Web e2e and story acceptance tests exist for product validation, including deterministic story runs and opt-in real Codex Goal Mode validation.
- Current Web and protocol surfaces use Knowledge Store terminology for the minimal existing knowledge slice.
- The current Web app is useful as a validation surface, but it should not be treated as the canonical source for core semantics.
- No implementation gap remains for this projection-posture spec. Full Web navigation, information architecture, and richer settings/diagnostics UX are deferred product work over the same NanoCore contracts, not blockers for this spec.

## Resolved Decisions

- Web UI work follows stable NanoCore, App API, protocol, and core docs.
- Superseded Web UI slice specs are historical references, not active requirements.
- Web-specific read models may exist, but they must be traceable to canonical workspace, thread, turn, item, artifact, knowledge, review, audit, permission, vault, agent, and runtime records.
- Web UI must not expose backend-private runtime state, raw secrets, raw OpenShell internals, or hidden agent-private task graphs as normal product concepts.
- New user-facing Web behavior that requires kernel semantics must first update the relevant protocol, NanoCore, core doc, or spec contract.

## Deferred / Future Work

- Rebuild Web navigation and information architecture around stable workspace, thread, Action Center, Knowledge Store, artifacts, agents, runtime, audit, and settings surfaces.
- Add richer workspace synchronization review and apply UX over the canonical review records.
- Add worker runtime diagnostics, agent capability summaries, audit, vault, policy, metering, and usage views as the underlying contracts stabilize.
- Mine superseded Web specs for useful interaction details during actual Web rebuild planning.

## Superseded Web Specs

The previous Web UI MVP slice specs have been moved under `docs/specs/retired/web-ui-pre-rebuild/` because the old module was deliberately removed and the current product surface is a clean-slate rebuild rather than a contract-preserving successor.

They are retained to recover useful copy, interaction details, and edge-case notes during future Web product work, but they no longer represent active release gates.

## Links

- [Work Model](../core/work-model.md)
- [Agent Workflow](../core/agent-workflow.md)
- [Core Architecture](../core/architecture.md)
- [Knowledge Model](../core/knowledge.md)
- [Agent Capability](../core/agent-capability.md)
- [OpenKit AI Interface](./20260617-openkit_ai_interface.md)
- [OpenKit Development Loop Protocol](./20260627-openkit_development_loop_protocol.md)
- [Workspace Synchronization](./20260703-workspace_synchronization.md)
