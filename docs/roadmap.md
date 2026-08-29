---
status: Accepted
---
# Product Roadmap

This document is the ordered completion path from the current implementation to the Product Vision. Work proceeds from top to bottom because later phases depend on the product behavior, operational confidence, and real usage established above them.

Each checkbox is one outcome-sized issue that can be delivered through one change plan, one pull request, independent review, and merge. An item is complete only when the capability works through its supported product surfaces, has proportionate regression and real-use evidence, and leaves its owning architecture and documentation current.

The list contains unfinished outcomes only. Completed foundations remain recorded by their Core documents, specifications, Git history, and verification evidence rather than by checked historical entries here. The architecture and current implementation decide how an issue is delivered; the Roadmap does not prescribe which specification, Core document, package, schema, or internal mechanism a team must change.

Roadmap completion is finite: it means the Product Vision and the concrete supported capability families below are complete. It does not require native adapters for every CMS, CRM, BI, analytics, messaging, Git, model, file, or domain system. Newly accepted product scope creates new roadmap work; it does not make this checklist an unlimited connector or feature backlog.

## Product boundaries

- NanoCore built-in agents absorb routine Workspace, Worker Agent, AEP, Policy, sandbox image, monitoring, and maintenance work; users provide goals, constraints, authorization, preferences, and decisions that cannot be made safely on their behalf.
- OpenKit is the user's all-in-one Workspace and workbench, not an all-in-one IT system. External systems retain their authoritative data and domain behavior while OpenKit connects the components needed to complete work.
- Operational Telemetry is diagnostic. Product history, Audit, Usage, Evidence, Review, and exact version lineage remain the authority for evaluation and self-improvement.
- Business World Model (`BWM`) and `Meta-Skill` capabilities live as independently versioned Skills. They do not turn BWM into a Core entity, universal ontology, second Knowledge system, or vertical workbench.
- Every later platform capability begins with a real supported use case. The Roadmap does not authorize a universal Resource model, connector framework, workflow engine, permission system, evaluation platform, or marketplace.

## Phase 1 — Establish a reliable product and release baseline

- [ ] R001 — NanoHost runs real Worker workloads without interfering with unrelated host networking, containers, services, or user data.
- [ ] R002 — NanoHost ships as an installable, verifiable distribution artifact that can be included in a tagged OpenKit release.
- [ ] R003 — An operator can install, upgrade, and roll back a NanoCore deployment across product versions with data, schema, and credential integrity preserved.
- [ ] R004 — Maintainers can prepare, publish, retry, and verify one complete tagged product release containing the App, Worker, NanoHost, and end-user `openkit` Skill assets.
- [ ] R005 — Worker execution preserves a truthful outcome across restart, reconnect, interruption, timeout, and cleanup failure.
- [ ] R006 — Repository read, edit, commit, and push work executes inside the governed Sandbox rather than through a NanoCore host checkout.
- [ ] R007 — Private repositories work through the same governed repository path without exposing credentials to Workers or product records.
- [ ] R008 — A Workspace can be backed up, exported, imported, rebound, and moved across deployments or machines with integrity and authority preserved.
- [ ] R009 — A locked-out server administrator can recover access through a bounded, audited, data-safe procedure.
- [ ] R010 — An authorized owner can delete or recover a damaged Workspace without silent data loss, authority drift, or unverifiable repair.

## Phase 2 — Complete the end-to-end Agent work loop

- [ ] R011 — All NanoCore internal roles run through one bounded, observable, policy-governed Internal Agent Runtime.
- [ ] R012 — Chat survives provider and process failures without losing, duplicating, or inventing a user request, answer, clarification, refusal, or handoff.
- [ ] R013 — Chat, Task, and Goal handoffs create a visible receiving Thread with complete parent, source, actor, and request lineage.
- [ ] R014 — A Task receives the exact authorized Knowledge and Workspace material selected for it, and the delivered bytes remain provable afterward.
- [ ] R015 — Every Goal records its autonomy level, budget, verification requirement, plan, responsible actor, and execution lineage from creation onward.
- [ ] R016 — Work for one Goal keeps compatible execution continuity while unrelated Goals remain isolated and independently scheduled.
- [ ] R017 — Goal work wakes, advances, revises its plan, stops repeated work, and reports blocked or uncertain states without hidden loops.
- [ ] R018 — The Workflow Coordinator can make bounded semantic planning, Worker selection, context, handoff, and stop decisions while deterministic control remains authoritative.
- [ ] R019 — Goal completion requires an independent verifier whose identity, evidence, findings, and final decision are inspectable.
- [ ] R020 — Supported Worker runtimes can surface approvals, questions, steering, follow-up, cancellation, and terminal results through the same Core work model.
- [ ] R021 — The unified `openkit` Skill and bundled CLI expose the complete user and operator capability set supported at this baseline or state an explicit exclusion.
- [ ] R022 — One reproducible public-surface journey completes from user intent through Agent work, human intervention, reviewed output, completion verification, and retained evidence.

## Phase 3 — Complete Telemetry, permissions, secrets, and governance

- [ ] R023 — NanoCore can emit vendor-neutral traces, metrics, and correlated logs through one supported Telemetry enablement and export path across local, test, container, and server deployments.
- [ ] R024 — An operator can follow one real request or Turn across NanoCore, Gateway, provider, scheduler, Worker, Sandbox, Workspace publication, and cleanup boundaries.
- [ ] R025 — Telemetry remains redacted, bounded, backend-neutral, safe to disable, and unable to block or redefine product success when collection or export fails.
- [ ] R026 — Repository tests and CI publish correlated machine-readable results that connect failures to the same runtime diagnostics used in production.
- [ ] R027 — Every server-scoped administration operation is covered by an explicit, explainable, deny-by-default Policy path that remains separate from Workspace content authority.
- [ ] R028 — Server secrets and Workspace secrets support governed creation, discovery, rotation, revocation, health inspection, and redacted audit history.
- [ ] R029 — Users and agents can request, review, grant, narrow, and revoke exact secret-use authority for a target Agent, Capability, lifetime, and visibility path.
- [ ] R030 — Secret injection records distinguish planned, attempted, completed, failed, stale, and revoked use without ever treating metadata as proof that a secret reached its target.
- [ ] R031 — Repository effects, runtime placement, and sensitive Workspace actions supported at this baseline are governed by current Policy decisions.
- [ ] R032 — A Policy or permission change takes effect safely during ongoing work by updating future checks, marking stale execution, or interrupting and replacing unsafe execution.
- [ ] R033 — Users and agents can request, review, grant, narrow, and revoke exact access to a named Workspace resource for a target member or Agent through the existing Policy Kernel.
- [ ] R034 — Audit, Usage, Evidence, and permission records cover every governed effect supported at this baseline with attributable actors, resources, outcomes, and redaction.

## Phase 4 — Move routine setup and management into NanoCore agents

- [ ] R035 — A built-in administration role handles routine system management through explicit automatic, proposal, approval, and prohibited action classes.
- [ ] R036 — A user can start from a goal and have OpenKit create or discover the required Workspace and bounded data sources with minimal setup questions.
- [ ] R037 — OpenKit reports one truthful setup-readiness result across providers, models, tools, sources, secrets, Policy, images, and runtimes, with each blocker and responsible next action identified.
- [ ] R038 — OpenKit selects an appropriate Worker Agent for the task and explains the choice, limitations, and any degraded capability.
- [ ] R039 — OpenKit proposes and maintains Agent and Policy configuration, then resolves a fresh governed AEP without asking users to edit AEP or runtime internals.
- [ ] R040 — OpenKit selects or builds a suitable sandbox image, verifies its identity and readiness, and explains why it is appropriate for the work.
- [ ] R041 — OpenKit refreshes images and replaces execution environments at safe boundaries without mutating running Sandboxes or inheriting stale authority.
- [ ] R042 — OpenKit monitors ongoing work and performs safe in-the-middle remediation through existing work, Policy, runtime, audit, and human-attention boundaries.
- [ ] R043 — Configuration surfaces show only goals, constraints, authorization, preferences, risk, exceptions, and required human decisions instead of routine system maintenance.

## Phase 5 — Complete the all-in-one Web workbench and judgement grounding

- [ ] R044 — The Web workbench shows the complete Workspace and Thread tree, task ownership, status, communication, handoffs, results, risk, and required attention.
- [ ] R045 — The conversation-first Web entry can start or continue Chat, Task, and Goal work and move to the corresponding Knowledge, repository, provider, and Workspace records without hidden route-specific state.
- [ ] R046 — Action Center can execute every approval, question, review, permission, escalation, budget, secret, Policy, recovery, and completion decision supported at this baseline.
- [ ] R047 — Users can inspect, compare, approve, reject, and apply Worker-proposed file and Git changes in the browser with clear conflict and uncertainty handling.
- [ ] R048 — Deployment administrators have a separate Web surface for server health, Telemetry, Audit, Policy, secrets, providers, backup, and recovery.
- [ ] R049 — The rebuilt multi-user Web projection passes real-browser and real-authentication acceptance for Workspace membership, invitations, ownership, access, attribution, and concurrent work.
- [ ] R050 — Artifacts appear as versioned, previewable, reviewable, reusable, and exportable work products rather than chat-only text.
- [ ] R051 — Workspace-native Materials complete their full browser and real-use lifecycle before richer interaction builds on them.
- [ ] R052 — A user can attach exact text-range feedback or a patch to a specific Material revision and receive a truthful stale, conflict, apply, or rejection result.
- [ ] R053 — A user can compare multiple candidates, select one with attributable judgement, and use that selection as precise input to the next work step.
- [ ] R054 — One concrete managed asset or bundle supports version lineage, preview, review, reuse, and import or export without becoming a universal Resource model.
- [ ] R055 — After bounded Workspace-local navigation and work discovery prove insufficient, Work Overview gives users a portfolio view across their Workspaces without merging Workspace authority or recreating a vertical business system.

## Phase 6 — Complete Agent capabilities and external-system integration

- [ ] R056 — Workers can discover and call governed Core capabilities through one supported capability interface with typed results and current authorization.
- [ ] R057 — Workers can request bounded Knowledge, Artifact, and diagnostic capabilities without receiving unrestricted access to Core stores or runtime internals.
- [ ] R058 — Workers can use supported MCP servers through governed lifecycle, schema, credential, approval, usage, audit, and teardown behavior.
- [ ] R059 — Capabilities have an inspectable catalog with per-capability limits, rate budgets, concurrency budgets, and explainable Policy decisions.
- [ ] R060 — Sandbox time, memory, storage, network volume, external usage, and cost are measured with durable attribution and useful cost projection.
- [ ] R061 — A Worker can use one authenticated third-party API without seeing the credential or bypassing approval, Policy, rate, Usage, and Audit controls.
- [ ] R062 — Worker network access uses one governed egress path with target restrictions, approvals, budgets, evidence, and truthful uncertain outcomes.
- [ ] R063 — LLM routing supports the selected provider families, subscription accounts, credential lifecycle, fallback, load balancing, and real-use verification.
- [ ] R064 — Image generation and cross-provider conversation handoff work through the same governed provider, Artifact, context, Usage, and Policy boundaries.
- [ ] R065 — One concrete object or provider-file data source supports immutable source identity, freshness, access Policy, derived representations, and bounded delivery to work.
- [ ] R066 — One concrete external business system is integrated as a Work Resource while that system retains authoritative data and domain behavior.
- [ ] R067 — The first external-system integration supports reviewed, permission-checked write-back without mirroring its database or workflow inside OpenKit.
- [ ] R068 — One non-GitHub hosting provider works through the same repository review, protected-branch, approval, push, and uncertain-outcome experience.

## Phase 7 — Turn real work into governed Knowledge, Skills, BWM, and self-improvement

- [ ] R069 — Knowledge retrieval handles current conflicts, freshness, sensitivity, access, and exact delivered content truthfully in every supported work mode.
- [ ] R070 — The semantic Knowledge Manager can search sources, prepare context, explain exclusions, and draft governed Knowledge changes through the shared Internal Agent Runtime.
- [ ] R071 — OpenKit extracts source-linked Knowledge candidates from real user-Agent work, corrections, Reviews, Artifacts, and interactions without self-promoting them.
- [ ] R072 — Generated Knowledge can be reviewed, applied, updated, merged, superseded, archived, reversed, and reused with exact source and content lineage.
- [ ] R073 — Knowledge V2 derives task summaries, stable preference candidates, agent-task fit, and context defaults with confidence, freshness, conflict handling, and human override.
- [ ] R074 — The Workflow Coordinator improves Worker, Skill, context, Agent configuration, and handoff selection from accumulated real outcomes.
- [ ] R075 — A real Worker Skill is delivered as a verified versioned package and consumed by a supported Worker path.
- [ ] R076 — Skill versions support immutable identity, a current version, Workspace pinning, reviewed promotion, verified delivery, and safe rollback without a marketplace.
- [ ] R077 — The first BWM Skill packages its theory, domain vocabulary, source mappings, reasoning guidance, operations, provenance, freshness, and conflict behavior outside OpenKit Core.
- [ ] R078 — A Meta-Skill creates a reviewable candidate BWM Skill from authorized Workspace information through an ordinary governed Task or Goal.
- [ ] R079 — A Worker receives and uses the exact Workspace-pinned BWM Skill version with complete input, execution, output, evidence, and review lineage.
- [ ] R080 — OpenKit records the exact Knowledge, Skill, BWM, scheduling, Agent, AEP, Policy, image, and Sandbox configuration used for comparable work outcomes.
- [ ] R081 — A bounded Task Evaluator compares outcomes and evidence, identifies regressions or opportunities, and proposes a second pass, revision, escalation, or improvement.
- [ ] R082 — Knowledge changes can follow a complete evaluate, propose, human-review, apply or reverse, and re-evaluate loop.
- [ ] R083 — Skill and BWM versions can be compared by performance, promoted or pinned through review, rolled back, and evaluated again on later work.
- [ ] R084 — Scheduling strategies can be evaluated, changed through governed configuration, rolled out safely, rolled back, and evaluated again without creating a second scheduler.
- [ ] R085 — Sandbox configuration strategies can be evaluated, proposed, applied through fresh governed environments, rolled back, and evaluated again.
- [ ] R086 — Repeated evaluations that cannot be represented safely by ordinary work and evidence can run through a bounded isolated Evaluation Harness with held-back checks and no automatic promotion.

## Phase 8 — Add channels, recurring automation, and reusable workflow composition

- [ ] R087 — External channels share one projection for identity, inbound work, outbound attention, notifications, retry, and authoritative Core outcomes.
- [ ] R088 — Discord supports starting work, answering gates, receiving progress, and viewing terminal results.
- [ ] R089 — Slack supports the same governed work and attention experience without owning separate workflow state.
- [ ] R090 — Signal supports the same governed work and attention experience without owning separate workflow state.
- [ ] R091 — Email supports configurable digests and required-attention notifications that return users to the authoritative OpenKit work and decision surface.
- [ ] R092 — A user can create and operate a recurring workflow through the existing scheduler with current authority checked before every run.
- [ ] R093 — An external event can trigger one governed workflow without creating a parallel event, retry, or recovery engine.
- [ ] R094 — Built-in agents can run periodic health checks and propose Workspace, Worker, Skill, Policy, image, and Sandbox maintenance through the same automation boundary.
- [ ] R095 — Demonstrated workflow needs can use dependencies, branches, joins, and reusable recipes without replacing the existing Goal, Task, Thread, Turn, Item, and scheduler model.

## Phase 9 — Complete the Generative Kernel, Desktop client, and measured runtime scale

- [ ] R096 — The Generative Kernel provides one governed structured-data module with validation, versioning, Policy, secrets, Audit, backup, and clear external-system boundaries.
- [ ] R097 — Users and Agents can operate Generative Kernel data through Web, the Agent Skill, CLI, and Worker capabilities with the same authorization and Audit model.
- [ ] R098 — Generative UI safely renders and edits Kernel-backed data with bounded components, capability limits, fallback, confirmation, and accessible interaction.
- [ ] R099 — One user-built internal coordination tool works end to end without turning OpenKit into its own CRM, CMS, BI, or analytics platform.
- [ ] R100 — OpenKit ships as a signed Tauri desktop application that can use a local NanoCore or connect securely to a remote Core.
- [ ] R101 — Desktop updates, credential storage, failure handling, and portable Workspace continuation work through supported release and recovery paths.
- [ ] R102 — The runtime supports multiple concurrent active Turns with independent identity, authority, cancellation, evidence, and capacity accounting.
- [ ] R103 — The scheduler can choose among multiple healthy runtime targets with clear capability, placement, failure, and teardown behavior.
- [ ] R104 — Compatible runtimes can be reused and refreshed between bounded steps without carrying stale context, credentials, Policy, or execution state.
- [ ] R105 — Multiple NanoHosts support the documented small-team workload with explicit placement and fairness, without introducing multi-tenant or federation assumptions.
- [ ] R106 — One reproducible release-gating journey completes on a real deployment from low-configuration Workspace setup through Assistant-to-Goal handoff, BWM-informed Agent work against an external system, a human decision through one supported channel, reviewed output, and retained Telemetry and canonical evidence.

## Links

- `docs/product-vision.md`
- `docs/core/README.md`
- `docs/specs/README.md`
- `docs/change-execution.md`
