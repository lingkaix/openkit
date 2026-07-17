# OpenKit Execution Program

Type: change-plan
Status: in-progress
Date: 2026-07-17

## Intent

Own the single ordered execution queue for all currently planned OpenKit work: the bounded closeout of the Core/spec/implementation alignment audit, the five planned implementation change plans, and the remaining time-boxed review passes.

This record owns only sequence, entry and exit gates, dispositions, the backlog, and the shared convergence rules. It owns no design contract and no implementation content. Every work package keeps its content in its owning change plan and canonical specifications; this ledger links to them and must stay under roughly 150 lines.

## Why This Record Exists

The [alignment audit](./202607111941330001-core_spec_implementation_alignment_audit.md) produced high-quality slices but converged slowly because of three structural defects recorded in its 2026-07-17 redesign: scope absorption (a review program implementing everything it found, so its finish line receded), uniform rigor (per-command distributed-systems exactness applied to a pre-release single-deployment product), and per-slice protocol overhead. The rules below are binding for every work package so those defects are not reproduced.

## Convergence Rules

1. No absorption. A work package implements only its frozen scope. Any new finding — including findings discovered inside the active package — is classified with the audit's finding codes and appended to the Backlog below, not implemented in place. Only `SECURITY-GAP` findings interrupt the active package.
2. Frozen scope. A package's scope is fixed when it activates. Scope changes require an explicit edit to this ledger with a one-line rationale; silent growth is prohibited.
3. Central idempotency default. All mode and workflow commands use the existing command-idempotency ledger with one shared policy: receipt present means replay projects stored identifiers plus current owner state; changed input returns `409 idempotency_key_conflict`; request-owned effects without a receipt return `409 recovery_required` with no inference, synthesis, settlement, or repair. Byte-exact response reconstruction is not a requirement; callers re-query state. Per-command contracts may narrow what a receipt stores; they may not add reconstruction obligations. This default is normative now and is promoted into C07 Protocol and S62 during WP-0.
4. Scoped precision bar. The "two independent implementers" bar applies only to Durable contract families under S62: persisted and portable truth, protocol records, identity, authority, audit. Release-coupled surfaces (App API, Core Client, bundled CLI, unified Skill, Web) require only single-implementation clarity plus test sufficiency, because they carry no cross-release compatibility promise.
5. Lightweight checkpoints. Checkpoints in owning plans are table rows or entries of at most 10 lines: scope, findings by class, commits, verification, remaining. Prose recitals of what was not added are replaced by rule 6.
6. Standing prohibitions. No work package may add: a second workflow engine, a settlement or recovery workflow, reservation or settlement records, compatibility shims or aliases for internal contracts, per-document tracking files, a new runner or acceptance harness, or a speculative framework. Stated once here; never restated per slice.
7. Bounded verification. Focused suites during a slice; affected-package suites plus repository gates at slice close; `verify:full` only at package exit. Per-slice re-reading covers the affected documents, not a full group set.
8. One active package. Work packages run sequentially. Documentation-only preparation for the next package may proceed in parallel; implementation may not.
9. Size caps. New change-plan prose stays under roughly 250 lines before implementation. Detail belongs in the owning specifications.
10. Real-use evidence first. Where a contract's remaining risk is behavioral rather than safety-critical, prefer shipping the surface and collecting dogfooding evidence over further pre-use specification.
11. Audit preamble. A work package that absorbs a dissolved audit group (WP-1, WP-2, WP-5, WP-6) records one review-only preamble checkpoint in its owning plan before implementation starts: the group authority map for the concepts the package touches, findings classified with the audit's finding codes (in-scope findings fold into the frozen scope; the rest go to the Backlog), and confirmation of the inherited group exit criteria. The preamble is bounded to at most one review day and authorizes no implementation.

## Work Package Queue

| # | Work package | Owning record | Entry gate | Exit gate |
| --- | --- | --- | --- | --- |
| WP-0 | Audit G01 bounded closeout | [Alignment audit](./202607111941330001-core_spec_implementation_alignment_audit.md) | Frozen closeout list recorded in the audit | Class A items verified; Class B recorded as accepted posture and the idempotency default promoted to C07/S62; Class C dispatched; G01 closed |
| WP-1 | Unified Agent Skill interface, absorbing audit G02 | [Agent Skill Interface plan](./202607131935040001-openkit_agent_skill_interface.md) | WP-0 exit; G02 audit preamble recorded in the owning plan | MCP package and four legacy Skills deleted; unified Skill and CLI pass the replacement acceptance stories |
| WP-2 | Worker Agent adapter boundary, absorbing audit G03 | [Adapter Boundary plan](./202607160036500001-worker_agent_adapter_boundary.md) | WP-1 exit; G03 audit preamble recorded | Fourth-runtime criterion holds (one profile, one adapter, one image); three adapters landed per the owning plan |
| WP-3 | Storage and provider review boxes: audit G05 and G04, review-only | [Alignment audit](./202607111941330001-core_spec_implementation_alignment_audit.md) | WP-2 exit | Combined time box of at most two review days; the Material-writeback owner decision (G05/C09) is recorded; all findings ticketed to the Backlog |
| WP-4 | Work and Resource Interaction Phase 1, absorbing the G01 evictions | [Work Resource Interaction plan](./202607132212000001-work_resource_interaction_model.md) | WP-3 exit; absorbed items recorded in the owning plan | S16 Phase 1 stages complete, including the S39 Context Package trace and Goal steering delivery |
| WP-5 | Contract stability and multi-user Workspaces, absorbing audit G06 | [Contract Stability plan](./202607160021540001-contract_stability_multi_user_workspaces.md) | WP-4 exit; G06 audit preamble recorded | Stability baseline gates pass; the owner-independent Workspace root migration is complete |
| WP-6 | Self-improvement loop foundations, absorbing audit G07 | [Self-Improvement plan](./202607111600390001-self_improvement_loop_foundations.md) | WP-5 exit; real dogfooding work history exists to mine | Loop foundations landed per the owning plan |
| WP-7 | Residual reviews (audit G00, G08, G09) and program closeout | [Alignment audit](./202607111941330001-core_spec_implementation_alignment_audit.md) | WP-6 exit | Time-boxed reviews done; the full real-use scenario matrix re-checked; the audit record reaches `verified`; this program closes |

## Ordering Rationale

- WP-1 before WP-2: deleting the legacy MCP surface and four Skills removes a test and maintenance drag that every later slice currently pays, the public command surface the CLI wraps is freshest immediately after WP-0, and it produces the first dogfooding surface — the real-use evidence the audit classifies as `REAL-USE-GAP`. The adapter boundary cannot change public APIs by its own acceptance criterion, so nothing in WP-1 waits on it.
- WP-2 before WP-4: S39 Context Package delivery and Material handoff ride the worker-runtime boundary that the adapters reshape; building delivery on a moving boundary would repeat rework.
- WP-3 before WP-4: the audit's Material-writeback item is explicitly blocked on one G05/C09 owner decision, which the time-boxed storage review makes. The G04 provider review closes the usage and attribution questions the self-improvement harness later depends on.
- WP-5 after WP-4: freeze the stability baseline only after the last planned public-surface churn (Skill interface, Artifact and Material commands) has landed, and migrate storage roots only after the G05 review confirms layout assumptions.
- WP-6 last among builds: the Reflector mines real work history, which only exists after WP-1 through WP-4 are dogfooded; the Harness depends on adapter and scheduler stability and the G04 review.
- The Web UI rebuild (S10) is not part of this program; it follows as product work over settled contracts, with the G09 review in WP-7 as its preamble.

#### Extra Note
WP-1 删 MCP 时 L6 故事的替换验收是硬出口条件，面积不小；WP-2 是三个真实 runtime 的集成，靠计划里的 stop rule 和最小首证防失控；WP-4 的 S39 trace 还需要一次规格级设计，别让它悄悄膨胀成新框架；WP-5 的存储根迁移接近不可逆，务必等 G05 评审盒确认布局假设之后动手；WP-6 的入口条件（真实 dogfooding 历史）是诚实的数据依赖，别提前。

## G01 Eviction Map

Items evicted from the audit's G01 group by its 2026-07-17 redesign, and their destinations. Each destination plan records the absorbed item when its work package activates.

| Evicted item | Destination |
| --- | --- |
| S16 Material identity, immutable revision, Thread binding, inclusion queue, reads, restart, portable export | WP-4 |
| S39 Context Package trace, Goal steering delivery, `lastWorkerSeenRevisionId` | WP-4 |
| Exact Artifact command surface: introduction, workspace-only import, deterministic refine and redo | WP-4 |
| Material worker proposal and conflict-safe writeback | Decision in WP-3; implementation in WP-4 |
| Final Web, CLI, and Action Center projections plus minimal acceptance for the items above | With their owning features |

## Backlog

New findings land here as one-line entries: `classification code — finding — proposed owner`. The active work package never absorbs them (rule 1). An entry leaves the backlog only by being scheduled into a work package through an explicit ledger edit.

- (empty)

## Checkpoints

- 2026-07-17 — Program established. Queue, convergence rules, eviction map, and backlog recorded; the alignment audit redesigned in the same slice.
- 2026-07-17 — Rule 11 (audit preamble definition) added; the four absorbing plans annotated with their inherited audit responsibility, the Work Resource plan annotated with its absorbed G01 evictions, and the in-flight direct-Task fence slice recorded into the G01 Class B landed baseline.

## Exit Condition

Every work package has met its exit gate, the Backlog is empty or every entry has an accepted owner and schedule, and the alignment audit record is `verified`. This record then closes with a final summary.
