---
status: Accepted
date: "2026-10-08"
decider: Engineer
---
# User-Selected Workspace-Shared Sandboxes

## Decision

Administrators configure and publish Sandbox templates; users select an existing Sandbox or create one from a configured template. The selectable resource is the existing Workspace-bound retained Worker environment association, with replaceable physical runtime instances. Current Workspace members may use each other's shared Sandboxes. Ordinary members may stop an idle realization and request deletion; only an administrator may purge retained data after reference, hold and writer-absence checks. [Persistent Worker Volumes](../specs/20260910-persistent_worker_volumes.md) owns the full resource, template, selection, failure and acceptance contract. These amendments govern implementation after `v0.1.0-rc.1`; that release does not wait for this feature.

The engineer's 2026-10-08 rulings are preserved verbatim below, followed by English translations. The translations describe the scope; they do not enlarge it.

1. Answer to whether users should choose a Sandbox: 「管理员配置的是模版（dockerfile一类的）, 但是用户可以选择使用哪一个sandbox，或者新建（使用配置好的模版）」. Translation: “Administrators configure templates, such as Dockerfiles, but users may choose which Sandbox to use or create a new one using a configured template.”
2. Selected sharing option: 「同一 Workspace 的成员都能选用彼此的 Sandbox（扩大信任边界：成员之间可以读写彼此的工作文件和原生会话数据）」. Translation: “Members of the same Workspace may select each other's Sandboxes, expanding the trust boundary so members can read and write each other's working files and native session data.”
3. Selected deletion option: 「第一版用户只能停止，删除（清除保留数据）仍由管理员执行，要先确认没有写入者、没有保留要求」. Translation: “In the first version, users can only stop; deletion that clears retained data remains an administrator action after confirming there are no writers and no retention requirements.”
4. Release scope: `v0.1.0-rc.1` does not wait for this feature. These amendments govern the implementation that follows the tag.

Sharing includes current and future members, with creator/contributor attribution rather than personal ownership or a reuse veto. It accepts mutual access to admitted working/native bytes and user-placed credential files, not another member's OpenKit-managed credentials or external authority. Separate slots prevent assigned-writer collisions but provide no confidentiality or protection against deliberate sibling modification under full Sandbox permission. Private conversation records and private native continuity remain restricted. Existing private associations keep exact authorized continuation; migration does not publish or attach them to others. Private-to-shared handoff still supplies only its confirmed selected payload.

The following earlier clauses are superseded only in their image-selection or reuse restriction; their credential, configuration, preparation/recovery, continuity, cleanup and disclosure criteria remain binding:

- Persistent Worker Volumes, Owned Operation Surface: the blanket administrator requirement for execution-storage maintenance, the Agent-only `{kind: 'agent', agentId}` preparation target, “neither an Agent profile nor a Thread acquires a separate image override,” and the requirement to create/select a distinct Agent configuration for task-specific environment supply. Bounded admitted-resource selection is now ordinary workload authority; arbitrary builds, publication, policy administration and physical purge remain administrator effects.
- Agent Manifest And AEP Resolution, Manifest Shape: “A task-specific environment uses a separately authored or selected Agent configuration.” A retained-resource reference may now select exact administrator-admitted template image supply; the Agent-scoped authored native environment map and protected bindings remain unchanged.
- Persistent Worker Volumes, Retained Bytes And Boundaries and Association And Lifecycle: cumulative responsible-user reuse and universal per-caller contributor-audience intersection become Workspace-shared resource eligibility plus explicit source-to-destination admission. Historical private-source restrictions and exact private continuation survive.
- Sandbox Core, Sandbox Scope, and NanoHost Runtime And Transport, Shared-Sandbox Harness Topology and Compatibility Decisions: responsible-user identity equality no longer excludes two eligible members in the expressly admitted Workspace-shared trust class. Every other compatibility, containment, credential and independent-adjudication criterion remains.
- Persistent Worker Volumes, Association And Lifecycle: Goal-level operational storage inheritance is reconciled with the accepted Goal owner. Cards pass exact choice as intent to ordinary Task admission, without a Goal pin or second lifecycle.

Earlier decision records, including Native Environment Managed Outside The Sandbox and Worker Environment Prepare And Recover Operations, remain unchanged as evidence of their original scope. This record does not rewrite them to imply they previously accepted selectable templates or Workspace-wide retained-data sharing.

## Reason

The engineer distinguishes administrator control of environment supply from a user's choice of where work and unfinished files live. A stable retained resource preserves that choice across runtime destruction and replacement without cloning Agents or adding a second resource registry. The sharing ruling expressly accepts the larger Workspace trust boundary and mutual access to working/native data. The deletion ruling keeps irreversible whole-volume erasure behind administrator authority and current retention/writer checks. The release ruling separates this subsequent implementation from the release tag. More detailed rationale for those selected options was not recorded; the owner realization follows the independent Consultant's Workspace-shared reuse addendum.

## Rejected Alternatives

- Administrator-only choice or an Agent clone per toolchain: contradicts the engineer's template-versus-user-selection distinction.
- Creator-only or same-responsible-user reuse: contradicts the selected Workspace-sharing option.
- Ordinary-member purge: contradicts the selected first-version deletion boundary.
- A public resource keyed by physical container identity or a second Sandbox registry: loses retained identity at replacement or duplicates existing association ownership without a present need.
- Publishing historical private volumes by migration or copying a whole private native home during selected-material handoff: exceeds the accepted sharing scope and violates source authority and data continuity.
- Treating user-placed credential files as protected personal Vault material, granting platform-managed credentials to siblings, or claiming slots prevent deliberate interference: misstates the accepted shared-byte consequence and the unchanged platform authority boundary.
- Holding `v0.1.0-rc.1` for this feature: contradicts the engineer's release scope.

## Revisit When

A qualified runtime cannot keep OpenKit-managed credentials outside retained shared bytes, cannot maintain exact native continuity and one writable attachment with separate assigned slots, or a concrete product need requires a narrower sharing audience, cross-Workspace reuse, ordinary-member purge or another durable owner. Any such change requires a new engineer decision rather than an implicit compatibility or cleanup exception.

## Affected Owners

- [Sandbox Core](../core/sandbox.md)
- [Storage Core](../core/storage.md)
- [Permissions Core](../core/permissions.md)
- [Runtime Model](../core/runtime-model.md)
- [Agent Supply](../core/agent-supply.md)
- [Persistent Worker Volumes](../specs/20260910-persistent_worker_volumes.md)
- [Agent Manifest And AEP Resolution](../specs/20260703-agent_manifest_aep_resolution.md)
- [Agent Environment Package](../specs/20260616-agent_environment_package.md)
- [Configuration Identity](../specs/20260628-nanocore_config_identity_contract.md)
- [Storage Layout And Record Ownership](../specs/20260703-storage_layout_record_ownership.md)
- [Task Mode](../specs/20260704-task_mode_worker_delegation.md)
- [Durable Scheduler](../specs/20260703-durable_scheduler_design.md)
- [NanoHost Runtime And Transport](../specs/20260802-nanohost_runtime_and_transport.md)
- [Goal](../specs/20261002-goal.md)
- [Unified Conversation Composer](../specs/20260831-unified_conversation_composer.md)
- [Thread Visibility And Sharing](../specs/20260909-thread_visibility_and_sharing.md)
