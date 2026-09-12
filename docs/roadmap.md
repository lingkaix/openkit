---
status: Accepted
---
# Product Roadmap

This document is the completion inventory from the current implementation to the Product Vision, plus the current execution order over it.

The engineer refreshed the execution direction on 2026-09-12: fewer than one week remains before the first release. Advance implementation in a few large cohesive batches, then run one consolidated release-candidate testing and acceptance campaign. Use OpenKit and the authorized Desktop/repository path for development, review and publication; do not wait for a new product-native engineering loop. Integrated performance evaluation goes last. The Phases are a capability inventory, not a serial prerequisite chain. The Execution Pathway below owns priority; accepted Core and specifications own behavior, and repository governance owns execution and acceptance.

Keep every R ID and its complete outcome. An unchecked item can be partly implemented or awaiting acceptance; it is not an instruction to rebuild it. Check an item only when its whole supported product outcome, proportionate regression and real-use evidence, and owning documentation agree. A verified slice does not close a broader parent outcome. Group related outcomes into one material development batch and PR where they share owners and integration seams; do not require one Task, plan, deployment or full L6 run per R ID. Preserve each outcome's acceptance obligations within the batch. Newly accepted scope adds explicit items rather than silently expanding existing ones.

## Current Baseline — 2026-09-12

The following capabilities are already available at the exact builds recorded in their evidence. Reuse them; do not start another platform-bootstrap program. They are not a fresh qualification of every host or the current HEAD. This ledger is a non-closing evidence map; only the R checkboxes record outcome completion. Linked observations retain exact machine/build identity; SSH aliases are labels, not qualification.

| Delivered capability | Evidence and remaining boundary |
| --- | --- |
| Initial NanoHost distribution; Workspace portability, administrator recovery and damaged-Workspace recovery; governed Worker MCP | R002, R008, R009, R010 and R058 remain complete. The initial NanoHost artifact's arm64 evidence does not certify x86_64 packaging or every host. |
| Persistent Web-directed Worker work and external Desktop Agent plus Skill acceptance | [Persistent live acceptance](changes/202609092147350001-persistent_live_acceptance/plan.md) is verified. Use these two paths for ordinary L6 and real Agent workloads; this does not close every feature's acceptance. |
| Exact-commit NanoCore/Web update, operator Skill and custom model metadata | [Agent-operated engineering](changes/202609101430000001-agent_operated_engineering/plan.md) is verified for its bounded delivery, including the A2 `62b54969` Web patch/review and public Skill update. That journey rejected the patch; it did not prove commit, push, PR creation or merge, cross-version data migration, or every Provider path. |
| Retained Worker volumes and safe compatible image replacement | [Persistent Worker environments](changes/202609101342020001-persistent_worker_environments/plan.md) is verified. The administrator-directed Web/private-Agent replacement and Desktop Skill replay on A1 bind App `5c78abe9`, actual successor tool execution, retained files/native history, absent old writers and effect-free Skill replay. R041 is complete; full R005 and R104 remain open. |
| Shared internal loop and private environment administration | The same environment delivery implements the bounded entry; it does not complete all-role runtime migration or general Workspace/Provider/Worker configuration proposals. R011 and R035 remain open. |

### Landed Work To Incorporate Into The Release Batches

| Existing plan | Current disposition | Next useful work |
| --- | --- | --- |
| [Generative Apps MVP](changes/202609090046400001-generative_apps_mvp/plan.md) | `implemented`; initial Kernel/native A2UI contract accepted | Carry the landed code into the release candidate and include its missing selected-Worker, browser edit/refresh and recovery proofs in the final campaign; correct locally discovered defects during development. Completing this plan does not complete full R096–R098. |
| [Agent Plugin, Skill and MCP Catalog](changes/202609081255000001-agent_plugin_skill_mcp_catalog/plan.md) | `in-progress`; independent findings and real consumption evidence remain | Reconcile actual current findings and finish implementation in the capability batch; prove exact versions, assignment and rollback through a real Worker in the final campaign. R075/R076/R108 remain open. |
| [Truthful Worker outcome and host qualification](changes/202609021052519141-phase1_host_qualification_truthful_worker_outcome/plan.md) | `in-progress`; later environment fixes provide reusable evidence | Compare remaining R005 predicates with current code and exact retained observations. Do not replay its historical teardown campaign or claim all supported adapters/failure modes passed. R109/R110 retain fresh-host requirements work. |
| [NanoHost release bundle](changes/202609012055216660-nanohost_release_bundle/plan.md) | `in-progress` despite the bounded historical R002 closure | Reconcile outstanding release/qualification work with R001/R004/R109/R110; neither rebuild R002 nor automatically close the larger plan. |

## Execution Pathway — First Release In Large Batches

The immediate objective is a release candidate with the largest coherent set of accepted capabilities completed, followed by consolidated acceptance. It is not a serial queue of fully accepted small features. The deadline does not turn unaccepted designs into implementation authority or promise that every conditional Roadmap outcome ships in the first release. Preserve the complete inventory for continued autonomous development after release; make any release-scope exclusion explicit rather than silently marking it complete.

### Development Batches

| Batch | First-release candidate focus: implement and integrate the accepted slices | Broader obligations retained, not made release prerequisites by this grouping |
| --- | --- | --- |
| A — Agent work and user control | Integrate the bounded internal runtime, private Assistant management and private/shared conversation paths with the real Web Task/Goal, independent verification and apply/review journey. Focus R005, the admitted-role part of R011, R012/R019/R035/R047/R049 and their actual dependencies; reuse the verified environment path. | Full R011–R022 and R035–R050 remain individually accountable. Do not infer complete remediation, every workbench projection or all-runtime behavior from this baseline. R006/R007/R111 publication is D1-gated; D2 blocks only the unresolved member-deletion payload. |
| B — Reusable capabilities and data | Finish the existing catalog and Generative MVP implementation alongside accepted scoped Memory/Knowledge and fixed-interval recurrence: R069–R072, R075/R076/R108, R080/R092 and the initial R096–R098 slice. Integrate their Skill and Web projections rather than deliver each API separately. Start recurring work early so real history accumulates. | Full Generative packages, richer operations, HTML delegates and saved views remain D3-gated. Systematic performance scoring, Skill A/B and improvement-loop infrastructure stay in final Phase 10, while ordinary editing/version selection and evidence capture work now. |
| C — Install and ship the integrated candidate | Finish release packaging R004, the declared installation/readiness profile, and actual Provider/diagnostic/configuration defects exposed while integrating A/B. Reuse custom-model metadata, operator Skill and App-update delivery. R001 and the applicable R109/R110 installation/qualification predicates are required before admitting a new user-owned host; qualification retains its own fixtures. | R003's cross-version migration/rollback proof waits for a second product version and data worth preserving. Full R023–R034, R051–R054 and R059–R064 are not silently added to the first-release critical path; their concrete missing accepted slices can be developed when needed, while D6/D8/D9 still gate new contracts. |

These are broad responsibility groups, not three new frameworks or a mandatory three-PR limit. At batch start, the existing release/change record names the selected first-release capability slices and their owner-derived pass/fail predicates; a parent R range is not a commitment to close every item. The same record names the integration owner and exact shared writable paths before parallel dispatch. Assign sizeable outcome-bearing Tasks with explicit write ownership; combine related changes into a coherent batch plan/PR and reuse existing plans rather than creating a plan for each API or R ID. Batches may advance concurrently on disjoint paths; one owner integrates shared runtime, schema, API/CLI and Web seams. Integrate regularly so incompatible assumptions fail during development, not first at final acceptance.

Select the next substantial accepted slice inside these batches by dependency and the stated release goal. When a local blocker prevents one slice, report it and advance independent accepted work. The Agent may investigate and settle ordinary implementation details, but a missing governing decision or conflicting owner goes to the engineer. Do not spend the release window building speculative extensions merely to clear the gate register. The release manifest and candidate record must name what actually landed, what remains blocked or unfinished, and which first-release requirements therefore remain unmet; the Roadmap is not a silent feature waiver.

### One Consolidated Acceptance Campaign

Before the final campaign, explicitly freeze the included first-release capability set and one exact integrated release candidate, and assemble the included plans' required observations into one campaign. During development run necessary focused regressions, typecheck, lint, build and independent source review; do not repeatedly deploy each plan or make a full L6 pass the prerequisite for starting the next batch. Brief probes that answer a concrete implementation uncertainty remain available, but are not another per-feature acceptance campaign.

Reuse the deployed two-mode infrastructure. In the final campaign, exercise the real chains through Web-directed work and Desktop Agent plus the packaged Skill: Agent execution and human intervention, private/shared access, management, exact Skill use/rollback, Kernel creation/data/form edit/refresh, Knowledge publication/history, recurrence and the included deployment/recovery predicates. Follow [Persistent Live Acceptance](cookbooks/persistent-live-acceptance.md) and each included owner's actual acceptance criteria; this list is coverage guidance, not a substitute oracle. One campaign still contains any required L6 repeated-story admission and independent Actor/Judge observations; it does not mean one attempt proves every story. Installation, destructive, crash and containment checks retain appropriately isolated authorized fixtures instead of breaking the shared deployment. Optional staging is available when the test actually requires it, not a mandatory second platform.

One observed journey may satisfy several plans when it proves each predicate. Record the mapping in the existing plans or release change record, with actual candidate, machine, scenario, public work identities, outputs and independent judgments; no new acceptance database or harness is needed. Previously retained evidence keeps its original build attribution. New fixes produce a new candidate revision; rerun the affected regressions and real journeys within this campaign, plus the final integration checks required by the changed boundary. Never relabel an old observation as a new-build pass.

Plans remain `implemented` or `in-progress` until their actual required proofs pass. Close the covered plans and check complete R outcomes from the campaign results, then release only the verified declared scope. Review and PR preparation can happen during development. If an existing plan reserves live proof before merge, keep its reviewed PR pending and use the integration candidate until this shared campaign discharges that condition; do not substitute a merge for acceptance or create a separate per-plan deployment to satisfy it early.

### Continue After The First Release

First finish release carryover, then select remaining accepted non-evaluation work by present user value and readiness: complete everyday work/control and reusable data/capabilities, prove a concrete external workflow with its channel/BWM, extend Generative Apps, then admit justified Desktop and scale work. Phase position is not an execution dependency or a reason to put broad governance ahead of usable capability. The blocked item stops only dependent work. Use actual professional workflows to admit concrete integrations/channels/BWM, richer Generative Apps, Desktop and measured scale under D1–D6/D8/D9. R106 retains its full integrated product journey and dependencies; a smaller first-release smoke cannot close it. R001 must precede any deployment onto a user's own machine.

Keep integrated evaluation in final Phase 10 and design it with the engineer after the platform runs and supplies real work. An untriggered optional extension does not justify speculative implementation before that discussion. Ordinary regression, independent Goal verification, L6, Agent task sets and evidence capture operate throughout. If only gated work remains, stop the dependent work and present those concrete decisions rather than inventing another queue or engine.

### Autonomous Development And Landing

Within an engineer-authorized implementation scope, Agents continue ordinary development, tests, commits, PR submission and merge without asking again for actions already covered by that authorization. Use existing Task/Goal, Skill/CLI, repository tools and [Change Execution](change-execution.md); this pathway introduces no background roadmap executor, workflow engine or new gate machinery. [CONTRIBUTING.md](../CONTRIBUTING.md) still requires independent approval and applicable checks before merge; lightweight PR CI alone does not replace the focused and real-use checks required by the changed surface. Preserve exact reviewed changes, branch protection and attributed evidence; fix failures rather than bypass checks or merge an unreviewed revision.

Repository-level authorization is not a product credential or a substitute for an exact human approval reserved by an accepted effect owner. The current `workspace.git.push` surface, protected-target rules and Agent-mediated App-update path retain their explicit approvals. D1 must settle the conflicting Git execution/credential boundaries and then define how a product-native unattended PR/merge path carries permitted authorization; until then, do not choose a publication locus or broaden credential access by inference. An admin token is no content bypass. PR/merge success never implies deployment success. NanoCore/Web activation uses the existing exact-target administrator approval; NanoHost updates, destructive tests and host interventions are separate effects.

Ordinary verification uses focused regressions first and the two persistent acceptance modes for L6 and real Agent tasks. Retain real output, public work identities, exact code/configuration inputs and independent deciding evidence. Use telemetry, logs, Audit, Usage and tracking to investigate a failure, reduce deterministic defects to an appropriate regression, fix them and rerun the affected acceptance. Follow [Persistent Live Acceptance](cookbooks/persistent-live-acceptance.md); installation, crash/containment and destructive proofs retain their own authorized fixtures. No clean reinstall per feature, routine NanoHost restart, mandatory second deployment or new evaluation service is required.

Continue substantial development batches without waiting for per-feature full live acceptance; keep branch/PR and plan status truthful throughout. Ask the engineer when current authority cannot settle a governing decision, a strict effect lacks authorization, a consequential disagreement remains or no credible safe route exists after investigation. An unavailable credential/model, failed test or incomplete implementation is an operational finding to diagnose, not automatically a reason to invent a new specification. Conversely, an Accepted heading alone does not authorize a deferred feature.

### Resolved Original Blockers

B1 deployment requirements, B2 fixed-interval scheduling, B3 initial Kernel/native UI, B4 Personal Assistant management, B5 Skill versioning/catalog and B6 Knowledge maintenance all have accepted initial contracts. Their implementation and acceptance gaps remain above. B4 does not require a separate administration Agent, and B5's missing delivery proof is not an unaccepted design. The historical `temp/pathway/20260903-execution-pathway-blockers.md` is not a current queue. The following local gates replace its stale global blocker labels.

### Remaining Local Design And Use-Case Gates

| Gate | Affected outcome | What must be settled before dependent implementation |
| --- | --- | --- |
| D1 — Git authority, then PR/merge contract | R006/R007, R111 and the product-native publication loop | First resolve the conflicting accepted owners: [Git Write Workflow](specs/20260704-git_write_workflow.md) keeps commits/push on the Core host and forbids Worker writes; [data sources](specs/20260704-workspace_data_source_catalog.md#contract--expected-behavior) and [static materialization](specs/20260704-session_static_workspace_materialization.md#git-source-materialization-boundary) place authorized Git/hosting operations in the Sandbox. Neither this Roadmap nor an implementation Agent chooses the winner. Separately accept the smallest PR/merge contract covering exact revisions/checks, current authorization, protected targets, credentials, retry and unknown outcomes; the current Git-write owner excludes PR creation. Existing apply/verification work may proceed independently where it does not depend on the disputed publication boundary. |
| D2 — Active-member lifecycle cutover | The relevant R049/member-access slice | [Multi-user Workspace](specs/20260715-multi_user_workspace_system.md#active-member-authorization-target) accepts equal-member access but requires the member-created deletion payload to preserve the initiating actor and existing recovery owner before code changes. Settle that seam; do not reintroduce owner/editor/viewer ceilings or redesign ordinary Workspace permissions. |
| D3 — Generative extensions | Full R096–R098 | [Kernel](specs/20260908-generative_kernel_data_operations.md#open-questions-and-deferred-extensions) retains richer query/mutation and app-package contracts; [UI](specs/20260908-generative_ui_interaction.md#open-questions-and-deferred-extensions) retains HTML resource/bridge/CSP/events/permissions and independent saved-view lifecycle/portability. Initial native work has no such gate and no upstream v1.0 release wait. |
| D4 — Additional orchestration and targets | R093, R095, R103, R105 | The [recurring owner](specs/20260711-scheduler_recurring_event_triggers.md#deferred--future-work) excludes external event subscriptions; [Goal Mode](specs/20260704-goal_mode_coordination.md) excludes a new graph/recipe contract; [runtime scale](specs/20260703-runtime_scheduling_scale.md#deferred--future-work) excludes dynamic multi-target placement. Demonstrate the required case and accept the narrow extension before implementing it. Bounded concurrency on the current target is already owned. |
| D5 — Desktop delivery | R100, R101 | [Web stack](specs/20260710-web_ui_rebuild_stack.md#deferred--future-work) defers Tauri packaging. Accept its concrete distribution/signing, credential, local/remote connection, update and recovery contracts; Web and Desktop Agent plus Skill do not depend on the desktop application. |
| D6 — Concrete integrations and optional breadth | R054, R065–R068, R087–R091, R033, R055 and R094 where it exceeds current operations | [Work Resource Interaction](specs/20260713-work_resource_interaction_model.md#deferred-work-resource-class-boundaries) requires concrete accepted contracts for managed assets and external business resources. Choose that asset/system and its authorized scenario. External channels need a shared projection contract for identity, inbound deduplication, gate responses and outbound delivery before the first adapter. Retain the existing need condition for Work Overview and finer resource grants; active membership remains the default. Customer autonomous host maintenance remains later scoped work, not a prerequisite for internal development. Resolve only missing owner details required by the selected slice. |
| D8 — Authenticated non-MCP APIs and egress | R061/R062 | [Worker MCP supply](specs/20260704-worker_mcp_tool_supply.md) excludes these concerns. Settle the selected API's credential mediation, target restrictions, approval, rate/Usage and uncertain-effect contract before enabling it. A working MCP path does not close this gap. |
| D9 — Provider routing and multimodal extensions | Remaining R063/R064 beyond supported profiles | [Pi-ai backend](specs/20260708-pi_ai_unified_llm_backend.md#decision) currently excludes automatic provider/account fallback and cross-provider handoff. Extend its owner for the selected routing, fallback, image generation or handoff case before implementation. Custom model IDs and mandatory context metadata are already delivered and need no redesign. |
| D7 — Integrated evaluation | Phase 10 | The [Evaluation Harness Draft](specs/20260711-evaluation_harness_design.md) preserves activation gates and unanswered lifecycle/authority questions. Design the four-target evaluation program together from actual observations at the final stage; add a separate Harness only where existing Task/Goal and evidence mechanisms cannot satisfy the demonstrated requirement. |

This is an inspected gate register, not proof that no future blocker exists. New evidence may expose another concrete missing contract; record its affected outcome and keep independent accepted work moving.

## Standing Constraints And Product Boundaries

OpenKit remains in internal developer preview with a small number of known users. Assurance breadth, operational completeness and governance breadth are deliberately underweighted in favour of capability a user can perceive and use; the strict boundaries below are exempt. Publishing a first version does not by itself qualify deployment onto another person's host. The release record must state the intended installation audience; if it includes user-owned hosts, R001 and the applicable R109/R110 installation/qualification predicates are mandatory before that deployment.

- Thin Generative Kernel means a thin interface, never weakened data durability: schema, lineage, validation, backup and portability remain required for every admitted data slice.
- The authenticated actor, current authority, confidentiality, Vault, exact human-gate principal, data preservation and sandbox containment remain strict. Active members have the accepted full Workspace/Light App operation baseline; private Assistant/Quick Chat and personal Memory remain User-scoped, while Task/Goal dialogue and Workspace Knowledge follow their shared audience owners.
- Internal Agents remain bounded Core consumers, not heavy Worker harnesses. Technical configuration and system operation require the requesting technical administrator's authority. Ordinary users are not asked to authorize host engineering they do not administer.
- NanoCore and Web can update independently of NanoHost. Worker environments and volumes are retained for scoped compatible reuse; retention does not permit cross-Workspace sharing, stale credentials or unproved execution recovery.
- OpenKit is an all-in-one workbench and integration glue, not a replacement CRM, CMS or BI platform. External systems remain authoritative for their domain data; BWM and Meta-Skill remain Skills, not new Core entities or an ontology.
- Optional operational telemetry is diagnostic; work history, Audit, Usage, Evidence, Review and exact lineage retain their own authority. Capture evidence now; defer the integrated performance framework, not correctness checks or independent verification.
- R001's internal-host risk cannot be carried onto a user's own machine. Release, migration and recovery evidence is bound to its actual version and host. Conditional later capabilities remain visible without turning a small-deployment platform into an unlimited connector, fleet, permission or evaluation project.

## Phase 1 — Establish a reliable product and release baseline

- [ ] R001 — NanoHost runs real Worker workloads without interfering with unrelated host networking, containers, services, or user data.
- [x] R002 — NanoHost ships as an installable, verifiable distribution artifact that can be included in a tagged OpenKit release. This closure records the initial arm64 artifact and its retained acceptance. The supported x86_64/arm64 contract is broader than that test coverage; correcting the remaining amd64 packaging, installer and qualification gaps is part of R109/R110, without invalidating the historical arm64 result.
- [ ] R003 — An operator can install, upgrade, and roll back a NanoCore deployment across product versions with data, schema, and credential integrity preserved. Its cross-version proof is deferred until a second product version and data worth preserving exist; a first tagged release does not close it.
- [ ] R004 — Maintainers can prepare, publish, retry, and verify one complete tagged product release containing the App, Worker, NanoHost, and end-user `openkit` Skill assets.
- [ ] R005 — Worker execution preserves a truthful outcome across restart, reconnect, interruption, timeout, and cleanup failure.
- [ ] R006 — Repository read, edit, commit, and push work executes inside the governed Sandbox rather than through a NanoCore host checkout. D1 gates this target: the accepted Git owners conflict on the execution locus, so it is not current implementation authority.
- [ ] R007 — Private repositories work through the same governed repository path without exposing credentials to Workers or product records. Its publication and credential boundary must be reconciled under D1 before dependent implementation.
- [x] R008 — A Workspace can be backed up, exported, imported, rebound, and moved across deployments or machines with integrity and authority preserved.
- [x] R009 — A locked-out server administrator can recover access through a bounded, audited, data-safe procedure.
- [x] R010 — An authorized owner can delete or recover a damaged Workspace without silent data loss, authority drift, or unverifiable repair.
- [ ] R109 — An Agent can install and configure a complete OpenKit deployment on a fresh host from repository guidance, and can state which host requirements the target does not meet.
- [ ] R110 — The real-host acceptance gate is repeatable on any host meeting a declared, machine-checkable requirement set, with every result bound to an exact product commit and an exact machine identity rather than to one named machine.

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
- [ ] R021 — The user-facing `openkit` Skill and bundled CLI expose the complete supported product capability set or an explicit exclusion, while the independent `openkit-ops` Skill packages installation, configuration, update and recovery guidance for Desktop Agents and authorized internal operators.
- [ ] R022 — One reproducible public-surface journey completes from user intent through Agent work, human intervention, reviewed output, completion verification, and retained evidence.
- [ ] R111 — A Web-directed engineering change can create a code-host PR, receive independent review and required checks, merge the exact accepted revision and retain its publication outcome through an explicitly authorized product path, with the accepted credential boundary and no unreviewed protected-branch mutation.

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

- [ ] R035 — The private Personal Assistant management entry lets a currently authorized technical administrator configure Workspaces, model providers and Worker Agents and explain or repair configuration errors through explicit automatic, proposal, approval and prohibited classes, without hand-editing server files.
- [ ] R036 — A user can start from a goal and have OpenKit create or discover the required Workspace and bounded data sources with minimal setup questions.
- [ ] R037 — OpenKit reports one truthful setup-readiness result across providers, models, tools, sources, secrets, Policy, images, and runtimes, with each blocker and responsible next action identified.
- [ ] R038 — OpenKit selects an appropriate Worker Agent for the task and explains the choice, limitations, and any degraded capability.
- [ ] R039 — OpenKit proposes and maintains Agent and Policy configuration, then resolves a fresh governed AEP without asking users to edit AEP or runtime internals.
- [ ] R040 — OpenKit selects or builds a suitable sandbox image, verifies its identity and readiness, and explains why it is appropriate for the work.
- [x] R041 — OpenKit refreshes images and replaces execution environments at safe boundaries without mutating running Sandboxes or inheriting stale authority.
- [ ] R042 — OpenKit monitors ongoing work and performs safe in-the-middle remediation through existing work, Policy, runtime, audit, and human-attention boundaries.
- [ ] R043 — Configuration surfaces show only goals, constraints, authorization, preferences, risk, exceptions, and required human decisions instead of routine system maintenance.

## Phase 5 — Complete the all-in-one Web workbench and judgement grounding

- [ ] R044 — The Web workbench shows the complete Workspace and Thread tree, task ownership, status, communication, handoffs, results, risk, and required attention.
- [ ] R045 — The conversation-first Web entry can start or continue Chat, Task, and Goal work and move to the corresponding Knowledge, repository, provider, and Workspace records without hidden route-specific state.
- [ ] R046 — Action Center can execute every approval, question, review, permission, escalation, budget, secret, Policy, recovery, and completion decision supported at this baseline.
- [ ] R047 — Users can inspect, compare, approve, reject, and apply Worker-proposed file and Git changes in the browser with clear conflict and uncertainty handling.
- [ ] R048 — Deployment administrators have a separate Web surface for server health, Telemetry, Audit, Policy, secrets, providers, backup, and recovery; the scoped Settings navigation, Token-derived session authorization, Configuration, AI interface, and access-token management slice is implemented while the remaining server surfaces stay open.
- [ ] R049 — The rebuilt multi-user Web projection passes real-browser and real-authentication acceptance for Workspace membership lifecycle, active-member access, invitations, ownership, actor attribution and concurrent work, with private Quick Chat/Assistant and shared Task/Goal audiences enforced through their accepted owners.
- [ ] R050 — Artifacts appear as versioned, previewable, reviewable, reusable, and exportable work products rather than chat-only text.
- [ ] R051 — Workspace-native Materials complete their full browser and real-use lifecycle before richer interaction builds on them.
- [ ] R052 — A user can attach exact text-range feedback or a patch to a specific Material revision and receive a truthful stale, conflict, apply, or rejection result.
- [ ] R053 — A user can compare multiple candidates, select one with attributable judgement, and use that selection as precise input to the next work step.
- [ ] R054 — One concrete managed asset or bundle supports version lineage, preview, review, reuse, and import or export without becoming a universal Resource model.
- [ ] R055 — After bounded Workspace-local navigation and work discovery prove insufficient, Work Overview gives users a portfolio view across their Workspaces without merging Workspace authority or recreating a vertical business system.

## Phase 6 — Complete Agent capabilities and external-system integration

- [ ] R056 — Workers can discover and call governed Core capabilities through one supported capability interface with typed results and current authorization.
- [ ] R057 — Workers can request bounded Knowledge, Artifact, and diagnostic capabilities without receiving unrestricted access to Core stores or runtime internals.
- [x] R058 — Workers can use supported MCP servers through governed lifecycle, schema, credential, approval, usage, audit, and teardown behavior.
- [ ] R059 — Capabilities have an inspectable catalog with per-capability limits, rate budgets, concurrency budgets, and explainable Policy decisions.
- [ ] R060 — Sandbox time, memory, storage, network volume, external usage, and cost are measured with durable attribution and useful cost projection.
- [ ] R061 — A Worker can use one authenticated third-party API without seeing the credential or bypassing approval, Policy, rate, Usage, and Audit controls.
- [ ] R062 — Worker network access uses one governed egress path with target restrictions, approvals, budgets, evidence, and truthful uncertain outcomes.
- [ ] R063 — LLM routing supports the selected provider families, subscription accounts, credential lifecycle, fallback, load balancing, and real-use verification, including xAI subscription accounts through slot creation, provider-profile binding, login and cancellation, automatic refresh, sanitized status, Grok inference, quota visibility, logout, slot deletion, and truthful failure behavior.
- [ ] R064 — Image generation and cross-provider conversation handoff work through the same governed provider, Artifact, context, Usage, and Policy boundaries.
- [ ] R065 — One concrete object or provider-file data source supports immutable source identity, freshness, access Policy, derived representations, and bounded delivery to work.
- [ ] R066 — One concrete external business system is integrated as a Work Resource while that system retains authoritative data and domain behavior.
- [ ] R067 — The first external-system integration supports reviewed, permission-checked write-back without mirroring its database or workflow inside OpenKit.
- [ ] R068 — One non-GitHub hosting provider works through the same repository review, protected-branch, approval, push, and uncertain-outcome experience.

## Phase 7 — Preserve Knowledge, Skills And Business World Models

- [ ] R069 — User Memory and Workspace/Server Knowledge retrieval handle current conflicts, freshness, sensitivity, scope access and exact delivered content truthfully in every supported work mode.
- [ ] R070 — The semantic Knowledge Manager can search sources, prepare context, explain exclusions, and draft governed Knowledge changes through the shared Internal Agent Runtime.
- [ ] R071 — OpenKit extracts source-linked Knowledge candidates from real user-Agent work, corrections, Reviews, Artifacts, and interactions without self-authorizing their publication.
- [ ] R072 — Generated Knowledge can be reviewed, applied, updated, merged, superseded, archived, reversed, and reused with exact source and content lineage.
- [ ] R075 — A real Worker Skill is delivered as a verified versioned package and consumed by a supported Worker path.
- [ ] R076 — Skill versions support immutable identity, a current version, Workspace pinning, reviewed promotion, verified delivery, and safe rollback without a marketplace.
- [ ] R108 — Users can import, install, update, and pin Skill versions and assign them to specific Worker Agents through the App surface, without editing repository or runtime files.
- [ ] R077 — The first BWM Skill packages its theory, domain vocabulary, source mappings, reasoning guidance, operations, provenance, freshness, and conflict behavior outside OpenKit Core.
- [ ] R078 — A Meta-Skill creates a reviewable candidate BWM Skill from authorized Workspace information through an ordinary governed Task or Goal.
- [ ] R079 — A Worker receives and uses the exact Workspace-pinned BWM Skill version with complete input, execution, output, evidence, and review lineage.
- [ ] R080 — OpenKit records the exact Knowledge, Skill, BWM, scheduling, Agent, AEP, Policy, image, and Sandbox configuration used for comparable work outcomes.

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

## Phase 9 — Complete Generative Apps, Desktop And Measured Runtime Scale

- [ ] R096 — A Light App has a stable file-authored schema and its own SQLite data kernel, managed primarily by agents through a Workspace Light App Catalog, with optional schema/resource import/export, semantic discovery, general query/bulk/transaction operations, validation, versioning, Policy, Audit, backup, and clear external-system boundaries.
- [ ] R097 — Users and Agents can operate Generative Kernel data through general MCP, Agent Skill/CLI, Worker, and Web projections with the same authorization and Audit model; optional fixed functions use existing Agent Plugin components.
- [ ] R098 — Generative UI safely renders and edits Kernel-backed data in the composed customer journey, with native components and a governed MCP Apps delegate, capability limits, isolated failure, confirmation, accessible interaction, and explicit saved-view reopen semantics. This composed outcome does not own independent Generative UI over existing sources.
- [ ] R099 — One user-built internal coordination tool works end to end without turning OpenKit into its own CRM, CMS, BI, or analytics platform.
- [ ] R100 — OpenKit ships as a signed Tauri desktop application that can use a local NanoCore or connect securely to a remote Core.
- [ ] R101 — Desktop updates, credential storage, failure handling, and portable Workspace continuation work through supported release and recovery paths.
- [ ] R102 — The runtime supports multiple concurrent active Turns with independent identity, authority, cancellation, evidence, and capacity accounting.
- [ ] R103 — The scheduler can choose among multiple healthy runtime targets with clear capability, placement, failure, and teardown behavior.
- [ ] R104 — Compatible runtimes can be reused and refreshed between bounded steps without carrying stale context, credentials, Policy, or execution state.
- [ ] R105 — Multiple NanoHosts support the documented small-team workload with explicit placement and fairness, without introducing multi-tenant or federation assumptions.
- [ ] R106 — One reproducible release-gating journey completes on a real deployment from low-configuration Workspace setup through Assistant-to-Goal handoff, BWM-informed Agent work against an external system, a human decision through one supported channel, reviewed output, and retained Telemetry and canonical evidence.

## Phase 10 — Integrated Evaluation And Improvement (Last)

Start this stage after the platform can carry real development and professional work. The engineer and Agents will design and implement the evaluation program together across internal Agents, task completion/results and performance, Worker Agents, and Skills including A/B tests. The outcomes below share that final-stage planning boundary; they do not prescribe separate evaluators, databases or runtimes. The current Evaluation Harness remains Draft until its activation and concrete-contract questions are resolved.

Ordinary regressions, independent Goal verification, L6, task sets, benchmark runs, notebook/Skill editing and reviewed version selection already use their existing owners and remain available earlier. Capture exact work, input, configuration and outcome lineage through R080 now. This final stage adds systematic comparison and improvement decisions; it does not retroactively make early work unverified or require a Harness for every comparison.

- [ ] R073 — Knowledge V2 derives task summaries, stable preference candidates, agent-task fit, and context defaults with confidence, freshness, conflict handling, and human override.
- [ ] R074 — The Workflow Coordinator improves Worker, Skill, context, Agent configuration, and handoff selection from accumulated real outcomes.
- [ ] R081 — A bounded Task Evaluator compares outcomes and evidence, identifies regressions or opportunities, and proposes a second pass, revision, escalation, or improvement.
- [ ] R082 — Knowledge changes can follow a complete evaluate, propose, human-review, apply or reverse, and re-evaluate loop.
- [ ] R083 — Skill and BWM versions can be compared by performance, including A/B tests, promoted or pinned through review, rolled back, and evaluated again on later work.
- [ ] R084 — Scheduling strategies can be evaluated, changed through governed configuration, rolled out safely, rolled back, and evaluated again without creating a second scheduler.
- [ ] R085 — Sandbox configuration strategies can be evaluated, proposed, applied through fresh governed environments, rolled back, and evaluated again.
- [ ] R086 — Repeated evaluations that cannot be represented safely by ordinary work and evidence can run through a bounded isolated Evaluation Harness with held-back checks and no automatic promotion.
- [ ] R112 — Internal Agent roles can be evaluated on representative work for correctness, completion quality, latency and resource use with identifiable role/model/configuration versions and inspectable independent evidence.
- [ ] R113 — Worker Agent configurations and supported runtimes can be compared on representative tasks for completion, output quality, reliability and resource use, with attributable inputs, environment and results rather than unsupported rankings.

## Links

- `docs/product-vision.md`
- `docs/core/README.md`
- `docs/specs/README.md`
- `docs/change-execution.md`
