# Skill Catalog Versioning And Pinning

Status: Draft
Implementation: Not Started

## Owns

- Skill version identity: the canonical content-addressed digest over a skill file tree.
- The Skill Catalog record contracts: catalog entries, immutable version records, current-version pointers, and workspace pin records.
- Publish, promote, rollback, pin, unpin, and deprecate operations and their governance tiers.
- The resolution rule that turns a skill reference into an exact version digest during Agent Environment Package resolution.
- Version content storage and digest verification at materialization.
- Import/export provenance for skills brought in from external sources, including agentskills.io-format skill directories.

## Does Not Own

- The skill file format itself beyond the identity rules here. Skills remain materialized files or directories per `docs/specs/20260616-agent_environment_package.md`; SKILL.md conventions follow the external agentskills.io specification where interop matters.
- Skill authoring UX or a Skill Creator surface.
- The `ImprovementProposal` lifecycle, evaluation, or evidence requirements for skill changes. `docs/specs/20260710-self_improvement_evaluation_loop.md` owns those; this spec provides the version substrate its `skill-version` proposals target.
- AEP materialization mechanics, supply snapshot shapes, or sandbox mounting. The AEP spec owns those; this spec only feeds resolved digests into them.
- Action Center gate mechanics and approval flows. `docs/specs/20260531-human_attention_intervention_model.md` owns those.
- MCP server catalog or data source catalog records; they are sibling patterns, not consumers.
- Storage layout policy. `docs/specs/20260703-storage_layout_record_ownership.md` owns the file-versus-SQLite policy; this spec projects into it.

## Core References

- `docs/core/agent-supply.md`
- `docs/core/architecture.md`
- `docs/core/audit.md`
- `docs/core/permissions.md`

## Related Specs

- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260703-agent_manifest_aep_resolution.md`
- `docs/specs/20260704-worker_mcp_tool_supply.md`
- `docs/specs/20260710-self_improvement_evaluation_loop.md`
- `docs/specs/20260531-human_attention_intervention_model.md`
- `docs/specs/20260704-workspace_backup_export_import.md`

## Summary

Skills are supplied to workers today from a hardcoded in-code table with a review status and no version concept. The self-improvement loop cannot ship its Phase 2 (`skill-version` improvement proposals) without versioned, pinnable, promotable skills, and its contract explicitly requires that promotion "updates the catalog version without unpinning workspaces that pinned the previous version".

This spec defines the Skill Catalog as durable records with content-addressed versioning: a skill version's identity is a deterministic digest computed from its file tree, so versions are immutable by construction; a catalog entry is a named pointer to a current version; workspaces pin digests; promotion and rollback are governed pointer moves; and AEP resolution records the exact resolved digest so every worker run and every evaluation replay is reproducible. The digest discipline mirrors the lockfile mechanism of the external `vercel-labs/skills` tool, but identity is always computed locally from content, never borrowed from a source host.

## Goals / Non-goals

### Goals

- Give every skill version an identity that is derived from its content, immutable, source-independent, and cheap to verify.
- Make "which skill did this worker run with" answerable exactly, from the package snapshot alone.
- Give the self-improvement loop the primitives its skill-loop phase requires: publish a candidate version, evaluate it against a pinned incumbent, promote by pointer move under Action Center approval, roll back by pointer move, and never disturb existing pins.
- Separate shared (server-scope) entries from workspace-scope entries so one workspace's learning cannot mutate a shared skill, per the self-improvement spec's layering rule.
- Stay interoperable with the external agent-skills ecosystem: import a SKILL.md directory from a local path or git source with recorded provenance.

### Non-goals

- Do not build a public skill registry, marketplace, or cross-deployment distribution protocol.
- Do not define semantic version numbers, ranges, or dependency resolution between skills. Versions are digests plus lineage metadata; ordering is by history, not by semver.
- Do not version prompt templates or knowledge records here; the self-improvement spec routes those through their own paths. (The version-pointer pattern here is available as prior art if prompt templates later need one.)
- Do not define skill execution semantics, allowed-tools enforcement, or skill sandbox behavior.
- Do not preserve the hardcoded in-code catalog as a fallback; it is replaced, per the repository rule against internal backward compatibility.

## Background

Current state: `apps/nanocore/src/runtime/agent-environment.ts` defines `WORKER_SKILL_CATALOG`, a hardcoded const mapping skill ids to entries with a source ref, target path, review status, and allowed runtime adapters. AEP resolution asserts the entry is approved and resolves it into the supply snapshot. There is no version identity, no persistence, no pinning, and no way to change a skill without a code deploy. Authored skill content lives in the repository `skills/` directory.

The self-improvement spec (`docs/specs/20260710-self_improvement_evaluation_loop.md`) names Skill Catalog versioning as a Phase 2 prerequisite and depends on: skill version selection and pinning events as Reflector input; `skill-version` improvement proposals carrying "concrete diff or new version content"; promotion that does not unpin workspaces; one-step rollback; and cross-workspace graduation where a workspace-local change becomes a shared-entry version only after shadow-evaluation quorum.

Prior art: the `vercel-labs/skills` CLI tracks installed skills in a lockfile keyed by content hash — a GitHub tree SHA for remote sources and a locally computed SHA-256 over sorted relative paths plus file contents for local sources — and detects updates by hash comparison. The local-hash construction (path included in the hash so renames are detected; deterministic path ordering) is the right identity discipline. Its remote-source shortcut (trusting a host-computed tree SHA) is not: identity must be computable and verifiable from content alone, independent of where the content came from. OpenKit already applies exactly this discipline to context packages (`docs/specs/20260703-worker_context_package.md` deterministic `contextPackageDigest` with digest-checked materialization readback), so the catalog reuses a proven internal pattern rather than importing an external dependency.

## Decision

- Skill version identity is a **canonical skill tree digest**: computed locally from the skill directory's file paths and contents, with an algorithm-versioned prefix. Two trees with the same digest are the same version; any file change is a new version.
- The Skill Catalog is a set of **durable records**: `SkillCatalogEntry` (named, scoped, carries a current-version pointer), `SkillVersionRecord` (immutable, digest-identified), and `SkillPinRecord` (workspace-scoped pin to a digest). Version content is stored content-addressed in a catalog content area; index records are SQLite, per the storage layout policy.
- **Promotion and rollback are pointer moves** on the catalog entry, never content mutations. Both are governed operations; promotion driven by an improvement proposal requires full Action Center approval per the self-improvement spec's tier table.
- **Pins are stable across promotion.** Resolution prefers a workspace pin over the entry's current pointer; moving the pointer never touches pins.
- **Scope layering**: server-scope entries are shared across workspaces; workspace-scope entries belong to one workspace. A workspace-driven change to a shared skill lands as a workspace-scope entry (overlay) or as a proposal against the shared entry — never as a direct mutation of the shared entry's content.
- The hardcoded `WORKER_SKILL_CATALOG` is **deleted and replaced** by these records in the same change.

## Contract / Expected Behavior

### Canonical skill tree digest

- Input: all regular files under the skill root directory. Directories contribute only through file paths. Symbolic links MUST be rejected at publish time. Empty directories are not part of identity.
- Construction: files are ordered by their root-relative path compared bytewise; path separators are normalized to `/`. The digest is SHA-256 over the concatenation, per file in order, of the relative path bytes and the exact content bytes, with an unambiguous length framing so path/content boundaries cannot collide.
- String form: `skv1:<lowercase hex>`. The `skv1` prefix names the algorithm and framing; any future change to either is a new prefix, and digests with different prefixes never compare equal.
- Determinism: the same tree MUST produce the same digest on every platform. Content bytes are hashed exactly as stored; no newline, encoding, or mode normalization is applied. File permissions and timestamps are not part of identity.
- Verification: any holder of the content can recompute and verify the digest. Digest verification failures are typed errors and MUST fail the operation that encountered them.

### Records

**`SkillCatalogEntry`** — one named skill. MUST carry:

- entry id and unique name within its scope
- scope: `server` | `workspace`, with workspace id when workspace-scoped
- description (from SKILL.md frontmatter at last publish)
- current version digest (nullable only before first publish)
- previous version digest (for one-step rollback; maintained by promotion)
- entry status: `active`, `deprecated`
- review status and allowed runtime adapters (carried over from the current supply governance fields)
- created/updated timestamps

**`SkillVersionRecord`** — one immutable version. MUST carry:

- version digest (primary identity)
- entry id
- file manifest: per-file relative path, per-file content digest, byte size; total byte size and file count
- source provenance: `authored` | `imported` | `improvement-proposal`, with a source reference (repository path, git URL plus revision, or `ImprovementProposal` id)
- parent version digest when the version was derived from another (nullable)
- publisher identity reference and created-at timestamp
- optional release note

Rules:

- Version records are immutable. Publishing content that hashes to an existing digest for the same entry is idempotent and returns the existing record.
- A version record MUST NOT be deleted while any pin, package snapshot, `EvalTask` environment, or improvement proposal references its digest. Garbage collection of unreferenced versions is deferred.

**`SkillPinRecord`** — one workspace's pin. MUST carry:

- workspace id and entry id (one non-terminal pin per pair)
- pinned version digest
- reason and actor reference
- status: `active`, `released`
- created/released timestamps

### Operations and governance tiers

- **Publish**: compute the digest, verify the tree (SKILL.md present with `name` and `description` frontmatter; no symlinks; size bounds), store content into the content area, create the version record. Publish alone changes no behavior — the current pointer does not move. Publishing to a workspace-scope entry is a governed workspace operation; publishing to a server-scope entry is a governed server operation.
- **Promote**: move the entry's current pointer to an existing version digest, recording the prior pointer as the previous version. Tiers: human-authored promotion is a governed configuration operation with audit; promotion originating from an `ImprovementProposal` MUST follow the self-improvement spec's full Action Center approval with the evidence bundle attached, and the proposal id MUST be recorded on the promotion audit event. Promotion MUST NOT modify or release any pin.
- **Rollback**: a pointer move to the recorded previous version (one step) or to any explicitly named existing version. Same governance surface as promotion; proposal-linked rollbacks reference the proposal per the self-improvement post-promotion rules.
- **Pin / Unpin**: workspace-scoped governed operations creating or releasing a pin record. Pinning to a digest that has no version record for that entry is a typed error. Pin and unpin events MUST be audited — they are first-class Reflector input signals.
- **Deprecate**: marks the entry `deprecated`; existing pins and snapshots keep resolving, new manifest references fail typed at resolution.
- All operations MUST produce audit events under `docs/core/audit.md` categories carrying entry id, digests involved, actor, and proposal linkage when present.

### Resolution into Agent Environment Packages

- An agent manifest references a skill by entry name (optionally qualified by scope) or by explicit `entry@digest`.
- Resolution order for a name reference: active workspace pin digest first; otherwise the entry's current version digest. An explicit digest reference resolves to exactly that digest.
- The resolved digest MUST be recorded in the AEP package snapshot's skill supply entry, alongside the entry id. A package snapshot never records "current"; it records the digest that was current or pinned at resolution time.
- Materialization MUST verify the content against the version's file manifest (per-file digests) before mounting, following the digest-checked materialization pattern of the context package spec. Verification failure fails the launch typed; it never mounts unverified content.
- Resolution failures (unknown entry, deprecated entry on a name reference, digest without a version record, review status not approved, runtime adapter not allowed) are typed errors surfaced through the existing AEP readiness path.

### Scope layering and graduation

- Workspace-scope entries and pins are the landing zone for workspace-local skill learning, per the self-improvement spec's shared-skill layering rule.
- A change intended for a shared server-scope entry from workspace evidence MUST arrive as a published (unpromoted) version on the shared entry plus a full-tier graduation proposal, gated by the shadow-evaluation quorum defined in the self-improvement spec. This spec enforces only the mechanism: publish-without-promote plus governed promotion is sufficient to represent that flow.

### Interop and provenance

- Import accepts a skill directory in agentskills.io SKILL.md format from a local path or a git source. Import is a publish: identity is the locally computed digest; the source URL and source revision (commit hash) are recorded as provenance only. A host-provided hash (for example a GitHub tree SHA) MUST NOT be used as identity and MAY be recorded as provenance metadata.
- Export produces the version's file tree plus a manifest containing the digest, suitable for external verification.
- Workspace-scope catalog entries, version records, pins, and referenced version content are included in workspace backup/export scope under `docs/specs/20260704-workspace_backup_export_import.md`; server-scope entries are deployment configuration and are not part of workspace export.

## Proposed Design

Catalog index records (entries, versions, pins) are SQLite rows in the appropriate scope databases per the storage layout policy; version content is stored once per content digest in a content-addressed catalog area under the server data root, with workspace-scope version content under the workspace data root so export scope stays clean. The digest function is one pure, platform-independent utility with exhaustive unit tests, implemented beside the existing context-package digest utilities. AEP resolution (`agent-environment.ts`) replaces the const-table lookup with record-backed resolution: pin lookup, pointer lookup, approval and adapter assertions unchanged in spirit, digest recorded on the supply snapshot. Governed operations surface through App API routes, `@openkit/core-client`, and MCP tools following the established catalog patterns (MCP server catalog, data source catalog). Repository-authored skills under `skills/` are seeded into the catalog by a publish step at bootstrap, keyed by their computed digests, replacing the hardcoded entries.

## Current Implementation Projection

Nothing in this contract is implemented. Current adjacent state: `apps/nanocore/src/runtime/agent-environment.ts` holds the hardcoded `WORKER_SKILL_CATALOG` with review status, allowed runtime adapters, source refs, and target paths, and `resolveWorkerSkillSupply` asserts approval before building supply snapshots (this spec replaces that table); authored skills live in the repository `skills/` directory; deterministic digest and digest-checked materialization precedents live in the context package implementation per `docs/specs/20260703-worker_context_package.md`; the workspace export portable/non-portable table coverage guard in `workspace-export.test.ts` is the enforcement point for adding the new workspace-scope records to export scope.

## Alternatives Considered

- Adopting `vercel-labs/skills` directly. Rejected: it is a client-side installation CLI writing into per-agent directories, with a lockfile that stores only the current hash and timestamps. It has no catalog service, no version history, no pinning/promotion/rollback semantics, no governance surface, and no API. Its content-hash discipline is adopted; the tool is not.
- Using host-provided hashes (GitHub tree SHA) as version identity for imported skills. Rejected: identity would depend on the source host's object model, could not be recomputed from content alone, and would differ from local identity for identical trees. Provenance metadata only.
- Semantic version numbers as identity. Rejected: semver is a claim, not a proof; two artifacts can share a number and differ in content. Digest identity makes immutability structural. Human-readable labels can be layered later as metadata without touching identity.
- Git as the version store (one repo or branch per skill). Rejected for V1: it drags in a second durability and access-control model for what is an index-plus-content problem; the AEP already consumes materialized trees, not git objects. Git remains an import source.
- Storing skill versions in the knowledge store. Rejected: same reasoning as the self-improvement spec's suite-storage decision — file-tree content with mount semantics has different lifecycle, consumers, and governance than OKF knowledge pages.
- Mutable "latest" resolution recorded in snapshots. Rejected: it would make package snapshots and evaluation environments unreproducible, violating both the AEP replay posture and the self-improvement spec's pinned-environment requirement.

## Consequences

- The self-improvement loop's Phase 2 prerequisites are discharged: candidate versions can be published and evaluated against pinned incumbents, promotion is an approvable pointer move with evidence linkage, rollback is one step, and pin events exist as durable Reflector signals.
- Every package snapshot gains an exact skill lineage, extending reproducibility from context packages to skill supply.
- Skill changes stop requiring code deploys; governance moves from code review to catalog operations with audit.
- New storage obligations: a content-addressed catalog area, export-scope additions, and a reference-counting discipline before any version deletion.
- AEP resolution gains a database dependency where it previously read a const; resolution failure modes become richer and must stay typed.

## Rollout / Migration Plan

New machinery replacing a hardcoded table; no compatibility path. Order: (1) digest utility with exhaustive unit tests; (2) record layer and content area with publish/pin/promote/rollback helpers; (3) AEP resolution switch from const table to records, seeding repository-authored skills via bootstrap publish in the same change; (4) governed App API / core-client / MCP surfaces plus audit events; (5) workspace export scope additions; (6) improvement-proposal promotion linkage when the self-improvement Phase 2 harness ships. Existing package snapshots created before this change carry no skill digests; they are historical records and are not migrated, per the internal-development rule.

## Testing Strategy / Acceptance Criteria

Mapped to the L0-L6 model in `docs/specs/20260529-test_strategy.md`:

- L0: schema-drift checks for catalog record shapes; repository check that `WORKER_SKILL_CATALOG` is gone; lint that no host-provided hash is used as identity.
- L1: digest determinism (same tree, same digest across path orderings and platforms), sensitivity (any byte, rename, add, delete changes the digest), framing non-ambiguity (path/content boundary collisions), symlink rejection, idempotent publish, pointer-move promotion and rollback invariants, pin-survives-promotion, one-pin-per-workspace-entry.
- L2: contract tests that AEP resolution records pinned-over-current digests, that explicit digest references resolve exactly, that deprecated entries fail name resolution typed, and that materialization verifies per-file digests and fails typed on tampered content.
- L3: NanoCore black-box tests: publish → promote → launch a worker and assert the snapshot digest; pin a workspace, promote the entry, launch and assert the pinned digest still resolves; rollback and assert one-step pointer restoration; tamper with stored content and assert typed launch failure; workspace export/import round-trips workspace-scope entries, versions, pins, and content.
- L5: smoke test that a packaged build seeds repository skills into the catalog and completes one worker launch with a digest-recorded skill supply.
- L6: story acceptance covering a human reviewing and approving a proposal-driven skill promotion in Action Center with evidence attached, a pinned workspace remaining on its version, and a subsequent one-step rollback.

Acceptance criteria: all L1-L3 behaviors pass deterministically; no code path can mount skill content whose digest verification failed; promotion never mutates pins; every promotion, rollback, pin, and unpin produces an audit event with digest lineage; a package snapshot alone suffices to name the exact skill versions a worker ran with.

## Risks & Mitigations

- Risk: digest algorithm or framing needs to change after digests are persisted everywhere. Mitigation: the `skv1` prefix versions the algorithm; new prefixes coexist, and cross-prefix comparison is defined as never-equal, so migration is republish-based and incremental.
- Risk: content area and index records drift (row without content, content without row). Mitigation: publish writes content before the version record; materialization verifies manifests; an integrity sweep is cheap because everything is content-addressed.
- Risk: seeding repository-authored skills at bootstrap creates confusion about the source of truth. Mitigation: seeded versions carry `authored` provenance with repository path and revision; after seeding, the catalog is authoritative for resolution and the repository directory is authoring input only.
- Risk: workspace-scope content in workspace data roots duplicates identical shared content. Mitigation: acceptable at V1 scale; content addressing makes future deduplication mechanical.
- Risk: governance surface sprawl (publish vs promote vs pin approvals confuse users). Mitigation: publish is inert by contract; only pointer moves and pins change behavior, and only those demand attention.

## Open Questions

- [Non-blocking] Whether agent manifests should support per-manifest digest pins in addition to workspace pins, and which wins when both exist. Current lean: manifest explicit `entry@digest` already covers the need; precedence rule needed only if both ship.
- [Non-blocking] Promotion authority for server-scope shared entries in multi-user deployments (who may approve), pending the broader permissions model for server-scope configuration.
- [Non-blocking] Whether human-readable version labels (for display beside digests) are catalog metadata worth adding at V1 or deferred with the Web UI surfaces.

## Deferred / Future Work

- Garbage collection of unreferenced version content with reference counting across pins, snapshots, `EvalTask` environments, and proposals.
- Human-readable version labels and richer version diff views for review surfaces.
- Prompt-template versioning, if it adopts the pointer-and-digest pattern established here (the self-improvement spec's `prompt-template` proposals will force this decision).
- Cross-deployment skill distribution and signature verification for imported skills.
- Deduplicated content storage across scopes.

## Links

- `docs/specs/20260710-self_improvement_evaluation_loop.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260703-agent_manifest_aep_resolution.md`
- `docs/specs/20260703-worker_context_package.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260704-workspace_backup_export_import.md`
- `docs/specs/20260531-human_attention_intervention_model.md`
- `docs/specs/20260529-test_strategy.md`
- vercel-labs/skills — lockfile content-hash discipline referenced as prior art. https://github.com/vercel-labs/skills
- Agent Skills specification (SKILL.md interop format). https://agentskills.io
