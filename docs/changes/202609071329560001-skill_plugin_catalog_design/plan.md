---
type: change-plan
status: verified
date: 2026-09-07
branch: main
---
# Skill, MCP, And Agent Plugin Catalog Design

This record preserves intent and design-work evidence. Design authority remains with the engineer's decisions and the owning Core and specifications, not this record.

## Intent Epoch 1

Source: the engineer's September 7 conversation request, following the earlier packaging-only clarification. English translation of the consequential direction: Agent Plugins is a convenient public packaging, declaration, management, and installation format; Skills are the most important resources supplied to workers and require strong independent versions for future A/B comparisons, rollback, and agent-submitted improvements, including future business-model improvement. Optional publisher versions should coexist with hash identities. Standardized Skills and MCP are in scope; client-specific extensions require later discussion.

The engineer reports MCP Gateway merged to main and requests complete resource-catalog and worker-supply design followed by implementation. The immediate request authorizes documentation with independent Consultant and Auditor agents if enough direction exists, and discussion of consequential unresolved choices. Documentation-phase acceptance is concrete, independently inspected Drafts covering ownership, versions, mutation, delivery, failure/recovery, and observable implementation predicates. It does not mean implementation, release proof, a commit, or approval of a new Core storage exception.

## Owners

- Existing boundaries: `docs/core/agent-supply.md`, `docs/core/storage.md`, `docs/core/permissions.md`, `docs/core/vault.md`, and `docs/core/audit.md`.
- Accepted Skill contract: `docs/specs/20260711-skill_catalog_versioning_pinning.md`.
- Accepted MCP management contract: `docs/specs/20260907-mcp_catalog_management.md`; the accepted effective-entry/Gateway owner remains `docs/specs/20260704-worker_mcp_tool_supply.md`.
- Accepted package/supply contract: `docs/specs/20260907-agent_plugin_packaging_and_worker_supply.md`, using the existing `docs/specs/20260616-agent_environment_package.md` and `docs/specs/20260802-nanohost_runtime_and_transport.md` boundaries.
- Existing Knowledge reflection and deferred Evaluation Harness retain their own scope.

## Intent Epoch 2

Source: the engineer's September 8 response annotations. English translation: the engineer accepts bounded, immutable, digest-verified installation snapshots with editable source and Git history remaining external; the Storage decision primarily concerns Workspaces connected to large code repositories. Bounded Skill snapshots linked to original versions are ordinary resource storage, not a special exception. The design must account for loading speed, performance, and convenience.

This resolves the sole pending decision from Epoch 1 and corrects its exception framing. Finalize the reviewed Skill, MCP, and Plugin specifications as Accepted / Not Started, clarify ordinary installed-resource storage in Core and the existing layout, and reconcile authored setup, AEP, Gateway, and NanoHost delivery owners. Keep large Workspace repositories, editable development sources, and their history external. Retained snapshots permit repeated launch and exact rollback without reacquiring the upstream source, subject to current authorization and verified integrity. This slice remains documentation-only and authorizes no commit or publication.

## Working Checkpoint

Current facts: work began on clean `main` at `13b85050`. Selected MCP Gateway exists; Skill supply remains static metadata with inert worker-side metadata files. Codex is pinned to 0.153.4 and native plugin support under its exact flags is unproved. Pi's registered legacy direct-provider adapter is not dispatch-ready under the current Gateway target.

Epoch 1 direction history: Consultant recommended Reframe then Continue from two to three narrow Draft owners, preserving independent Skill evolution without mixing an unaccepted catalog lifecycle into the accepted Gateway. The primary adopted this split, the whole Skill-directory payload, and a private package root for stdio MCP. Consultant recommended bounded canonical installed snapshots over Git-only locators/cache and raised the then-unresolved Core storage interpretation. Epoch 2 resolves that interpretation as ordinary product-resource storage. The proposal and direct research remain under `temp/research/agent-plugins-design-20260907/`.

Write ownership for Epoch 2: the primary alone edits the three catalog specifications, `docs/core/storage.md`, `docs/core/agent-supply.md`, the existing storage-layout, AgentManifest/AEP-resolution, AEP, worker-MCP-supply, NanoHost data-boundary, NanoHost runtime, Agent Skill Interface, and Workspace backup/export/import specifications, this plan, and the generated index. Consultant/Auditor remain read-only on canonical paths and may retain scratch beneath the research directory. No production file is in scope. Auditor identified the existing Agent Skill Interface as a named management consumer with an ambiguous CLI-plugin prohibition; the primary adds only its ordinary public-operation projection boundary, without a CLI framework or new capability route.

Epoch 1 audit history: independent inspection found and the primary corrected ordinary metadata versus raw-package/export authorization, unique source-root and mutable MCP-data ownership after independent adoption, redirect rejection at the actual Gateway boundary, and an exact derived-supply digest domain. Self-review also made empty directories part of tree identity, retained-content dependencies finite rather than accidental permanent retention, and worker candidate submission reachable through existing exact Artifact lineage without a management token. The Auditor inspected the final changed bytes and returned Ask Human with no remaining implementation-readiness finding other than the explicit Core storage decision. That is an independent fidelity judgment, not engineer approval or runtime proof.

Fresh direction for the export consumer: Auditor found the existing V2 same-change durable-family classification requirement. Consultant independently returned Continue: use the existing portable whitelist and required-feature mechanism for independent Skill content and redacted package/MCP lineage; keep raw Plugin roots, executable configuration, mutable MCP data, and source authority non-portable. Full data-root backup preserves same-deployment state. This follows existing confidentiality and import ownership and needs no new user decision. The primary alone adds the owner classification and implementation acceptance, without production exporter or coverage changes before catalog records exist.

Fresh direction after the overnight pause: Consultant inspected current intent and the checkpoint and returned Continue. The user resolved the prior Ask Human condition; no new permission is required. Local canonical snapshots avoid mandatory upstream lookup during launch and rollback without introducing a cache service, deduplication platform, or source-hosting capability.

Next Action: the documentation phase is complete. Implementation proceeds under these accepted owners through the complete catalog-management, package-import, governed MCP, exact worker-supply, portability, and real-worker acceptance slice; its runtime evidence and execution coordination are separate from this verified design record. No additional storage decision or design blocker remains.

## Closeout Summary

the three catalog contracts are Accepted / Not Started and the existing Storage, setup, AEP, Gateway, Sandbox delivery, unified Skill/CLI, and Workspace portability owners are aligned. Independent Auditor inspected the final bytes, including the export/import receiver, and returned Continue with no remaining actionable fidelity, ownership, or implementation-readiness finding. The review corrected pin-state wording, standard stdio working-directory/environment semantics, the CLI-owned plugin prohibition, and complete portable/non-portable classification; self-review kept snapshot ownership entry-scoped and excluded Git administration from installation payloads.

## Verification

The requested npm page was unavailable; upstream `vercel-labs/skills` local-lock source verified folder-content SHA-256 identification. This supports the hash approach, not adoption of its encoding, lock format, or dependency. Standard and current-source evidence is retained uncommitted under `temp/research/agent-plugins-design-20260907/`.

Observed focused verification on the repository-pinned Node 24.18.0: `node scripts/validate-spec-lifecycle.mjs` passed; `node scripts/validate-doc-model.mjs` passed for 229 documents; `node scripts/generate-doc-index.mjs --check` reported the index current; `git diff --check` passed. The generated index was refreshed through its existing generator. Initial structural checks also passed under the shell's unexpected Node 22.22.3; after correcting this task's PATH to the existing mise shims, the named final checks ran under the pinned runtime. No toolchain file changed.

These checks establish documentation structure only. Auditor judgment addresses the finite intent/authority concerns and is not deterministic runtime proof. No production code changed, so no runtime test, implementation, native-worker, release, or A/B effectiveness result is claimed. No commit, publication, service mutation, or plugin installation occurred. Read-only research remains under ignored `temp/research/agent-plugins-design-20260907/`; Epoch 2 resolves the engineer's storage decision, and independent final audit closes this documentation phase. No unresolved design finding remains; implementation and native-worker proof are still outstanding by design.

Final verification after owner alignment used Node 24.18.0: specification lifecycle passed, documentation model passed for 229 documents, generated index was current, and diff whitespace passed. Auditor independently repeated the structural checks and checked the two new specifications and plan. Its final judgment covered the actual changed documentation, not only this report. No code, dependency, toolchain, service, credential, or runtime artifact was changed; no commit or publication occurred.
