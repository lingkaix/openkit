---
status: Accepted
date: "2026-10-14"
decider: Engineer
supersedes: docs/decisions/20260928-compatibility_rests_on_data.md
---
# Pre-Stable Data Continuity

## Decision

The engineer chose option B on 2026-10-14. NONNEG-001's data-continuity obligation starts with the first stable release, `v0.1.0`. A prerelease does not start it. Before that release, a change may reset deployment data instead of migrating it. Work must already move toward stable storage and file formats and safe retention and reading after release. Each shape needs an owner, a closed core, and an open extension. [Contract Evolution](../core/contract-evolution.md#retained-data-continuity) owns that boundary. Only the engineer edits root AGENTS.md; the clause amendments remain a separate proposal.

A release that cannot read the previous release's retained data must say so in its release record and operator procedure. A reset requires explicit operator authorization and scope. It preserves the engineer-named accounts and does not follow automatically from startup failure. [Release Management](../specs/20260829-release_management.md#pre-stable-deployment-reset-and-protected-accounts) owns these minimum reset conditions. This documentation change resets no deployment.

On this development machine, `a1` staging, and `a2` production, the accounts the engineer names for each deployment stay registered and usable through every reset and reinstall. The operator keeps their list and credentials outside the repository. The coordinator and the test agent use the account the engineer designates for staging. This record contains no personal account data or credential location.

From `v0.1.0`, retained canonical records, persisted protocol records, retained evidence, SQLite source-of-truth records, and authored configuration stay usable. Additive evolution or an accepted one-way migration carries them forward. Removing them requires an explicit data-retirement decision. A permanent legacy reader or dual write does not satisfy that obligation. SQLite keeps its release-scoped migration owner: applied migrations in a carried-forward database remain immutable, and schema changes use incremental migrations. An explicit pre-stable reset may initialize the current release without carrying predecessor rows forward.

The valid parts of the 2026-09-28 ruling remain. First-party App APIs, protocol wire shapes, clients, CLI, Skill, Web, and implementation ship together and carry no compatibility obligation unless a separately accepted contract creates one. Refactoring removes obsolete implementation instead of adding compatibility layers, deprecated shims, or dual writes. Core semantics stay Durable while their projections change. Protocol minor versions may carry breaking schema changes under an accepted specification at any phase; the retained-data obligation still applies from `v0.1.0`.

Configuration readers ignore unknown future additive fields, with a located warning for authored configuration. Unknown closed-core values, unknown authority-bearing fields, and unsupported required semantics fail closed. Every owned shape follows the closed-core and open-extension partition. Rebuildable derivatives, caches, disposable diagnostics, operational telemetry, and generated execution contracts keep their owners' classifications. Opaque Worker bytes retain their lifecycle owners without an OpenKit format promise. Closed-core validation, authorization, revocation, retention, holds, and external-effect uncertainty remain strict. An explicit pre-stable reset does not weaken ordinary lifecycle or recovery rules for data that it retains.

## Reason

The engineer's words on 2026-10-14, verbatim:

> B, 应遵循 Agents.MD 当中的工程原则。 九月二十八号那次的裁决是一次误读，正确的解释应该是，我们从现在开始到第一个稳定版本上线之前，应当开始考虑版本上线之后用户的数据可以被安全的留存和读取的问题，但并不强制现在就要保证所有的数据都是兼容的, 而是现在开始向着存储与文件格式的稳定这个方向努力。不过这里有一个小细节，就是这三台服务器，你需要保证这三个账号始终都是被注册而且可以被使用的。 其中，你和测试的 agent 持有和使用 staging 那个账号 进行测试、验收、维护和其他操作。

Translation, with the account wording corrected to match the quote:

> B; follow the engineering principles in AGENTS.md. The 2026-09-28 ruling was a misreading. The correct interpretation: from now until the first stable release ships, we should start to consider how users' data can be safely retained and read after release, but it is not mandatory now to guarantee that all data is compatible; instead we now start to work toward stable storage and file formats. One small detail: on these three servers, you must make sure these three accounts are always registered and usable. You and the test agent hold and use the staging account for testing, acceptance, maintenance and other operations.

The 2026-09-28 record misread an instruction to work toward stable storage as an immediate obligation to preserve all retained data across changes. The engineer corrected that reading and chose the standing stable-release boundary. The earlier message about the three deployments having no production data explains the current identifier cutover; it is not a standing claim that pre-stable deployments can never hold user data.

Option B keeps preparation for future retention separate from mandatory continuity after release. A pre-stable reset can avoid an unnecessary migration, but operators must know which release cannot read predecessor data. Preserving the required accounts keeps the deployments usable for their owners and for staging operations. The reset conditions above are the writer's minimum realization for Consultant scrutiny; they add no reset service, account store, or automatic recovery mechanism.

## Rejected Alternatives

Option A was a one-time exception for the current identifier cutover, with immediate continuity continuing for other pre-stable changes. The engineer chose option B instead and explicitly corrected the 2026-09-28 reading. The correction therefore applies until `v0.1.0`, not only to this cutover.

The earlier alternatives remain rejected where they concern scope or mechanism: release-coupled surfaces need no general support window, everything on disk is not automatically Durable, and permanent legacy readers or dual writes do not preserve data under the obligation. Separately accepted external contracts retain their own requirements. A stable-release boundary does not authorize automatic startup resets or silent account deletion.

## Revisit When

Revisit the reset permission if the engineer changes the stable-release boundary or a separately accepted contract requires earlier continuity. At `v0.1.0`, mandatory data continuity begins. Revisit a reset procedure when it cannot preserve the required accounts or safely fence the affected effect domains. A later data retirement still needs its owner's explicit decision.

## Affected Owners

- Root AGENTS.md, NONNEG-001 and COMPAT-001: the engineer applies the proposed replacements.
- [Contract Evolution](../core/contract-evolution.md): the continuity boundary, pre-stable preparation, and unchanged strict rules.
- [Release Management](../specs/20260829-release_management.md): reset disclosure, operator scope, protected accounts, and Story 2 release qualification.
- [L6 Story Acceptance](../specs/20260529-l6_story_acceptance.md): Story 2's conditional data-continuity predicate.
- [App Update Delivery](../specs/20260910-app_update_delivery.md) and [Persistent Deployment Acceptance](../specs/20260909-persistent_deployment_acceptance.md): ordinary update grants remain separate from explicit resets.
- [Storage Layout](../specs/20260703-storage_layout_record_ownership.md), [Schema Evolution](../specs/20260703-schema_evolution_record_envelope.md), and [Contract Stability Baseline](../specs/20260715-contract_stability_baseline.md): migration requirements follow the stable-release boundary or the selected carry-forward path.
- [NanoHost Runtime](../specs/20260802-nanohost_runtime_and_transport.md): retained-input replacement and conversion rules exclude an explicitly authorized pre-stable reset; fencing and recovery stay strict.
- [Configuration Identity](../specs/20260628-nanocore_config_identity_contract.md), [Agent Manifest](../specs/20260703-agent_manifest_aep_resolution.md), [Agent Environment Package](../specs/20260616-agent_environment_package.md), and [Worker Reliability](../specs/20260531-worker_turn_reliability_envelope.md): future changes follow the corrected continuity boundary.
- [Core Storage](../core/storage.md): opaque retained bytes follow the same release boundary without weakening ordinary storage lifecycle rules.
- [NanoHost Workspace Data Boundary](../specs/20260801-nanohost_workspace_data_boundary.md) and [Persistent Worker Volumes](../specs/20260910-persistent_worker_volumes.md): the WP1 builder must align their retained-byte and association rules; this writer does not edit those paths.
