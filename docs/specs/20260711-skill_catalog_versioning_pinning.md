---
status: Accepted
implementation: Partial
kind: concept
updated: 2026-10-17
---
# Skill Catalog Versioning And Pinning

## Owns

- Independent worker Skill identity, immutable content versions, provenance, candidate submission, exact selection, promotion, pinning, rollback, and removal.
- Deterministic bounded-tree identity for installed resource snapshots.
- Skill delivery integrity and the version lineage needed for comparisons through existing work and evidence records.

## Does Not Own

- Agent Plugin packaging or MCP configuration versions, which have separate specifications.
- Skill execution, model obedience, sandbox privileges, network access, credentials, or tool permission.
- An experiment scheduler, Judge, scoring system, autonomous promotion policy, generic improvement framework, or business-model implementation.
- Knowledge Proposal or Review semantics, external product client packaging, Git hosting, or source-development workflows.
- AEP, AgentSession, transport, command-ledger, audit, or evidence lifecycles already owned elsewhere.

## Core References

- `docs/core/foundation.md`
- `docs/core/agent-supply.md`
- `docs/core/storage.md`
- `docs/core/permissions.md`
- `docs/core/audit.md`

## Summary

Skills are first-class, independently versioned worker resources. A Skill may arrive alone, through an Agent Plugin, or as an agent-submitted candidate; its version and selection must not depend on publishing a new community plugin. OpenKit retains exact immutable content so a later comparison, promotion, or rollback identifies the actual instructions, scripts, and supporting files supplied to a worker.

This contract replaces the earlier future-only entry conditions with the requested target. Real Skill consumption and version changes are acceptance observations to deliver, not prerequisites preventing design work. The existing MCP Gateway is an available dependency. Catalog lifecycle and native Skill loading remain partially implemented; the current projection below names the remaining integration and acceptance work.

## Goals / Non-goals

Cover creation, import, enumeration, inspection, content comparison, candidate submission, exact selection, promotion, rollback, and removal through one NanoCore owner. Enable future A/B evaluation and agent improvement proposals through immutable inputs and attributable work. Do not build an evaluation platform or make current Knowledge reflection depend on this catalog.

## Background

The earlier Draft preserved useful integrity, pointer, pin, AEP, and restart constraints but excluded a current catalog. The present product requirement establishes the need for real worker Skills and independent evolution. Plugin packaging distributes resources; it is not their version authority.

## Decision

- Every Skill has a stable scoped identity and immutable versions identified by a locally computed digest, regardless of optional publisher version labels.
- The complete self-contained Skill directory is the version unit. Sibling Skills, MCP declarations, plugin metadata, and extension directories do not enter its digest.
- Candidate creation does not change active selection. Promotion, pinning, exact test selection, and rollback require their own current authority.
- NanoCore resolves exact versions before AEP creation. Integration verifies and installs those files through the selected runtime adapter.
- Bounded immutable installed snapshots are ordinary catalog-owned product resources under Storage Core; source-development repositories and Git history remain external.

## Contract / Expected Behavior

### Identity, scope, and provenance

A `SkillEntry` has an owner scope, stable catalog id, display metadata, availability, and one nullable current digest. User imports and local creation target one Workspace. Server-owned entries may be projected read-only into authorized Workspaces; editing one creates a Workspace entry with source lineage. Display names and public package names confer neither uniqueness nor ownership.

A `SkillVersion` records entry identity, exact digest and format, file inventory, optional publisher version, producer, creation time, and immutable provenance: source commit/subpath when available, uploaded-source identity otherwise, originating plugin membership when applicable, and the exact base version for local improvements. A Skill revision never rewrites its original PluginVersion membership.

Identical bytes in the same entry reuse content identity; a separate import observation may retain additional provenance without rewriting the version. Same-label different content has different digests and is visibly distinguishable. Tags, branches, `latest`, timestamps, and remote tree hashes are not executable identities.

### Ecosystem source admission

The accepted source and local CLI sharing choices, their reasons and their limits are recorded in [Ecosystem Skill Import And Local Staging](../decisions/20261016-ecosystem_skill_import_and_local_staging.md).

The curated sources are [Anthropic Skills](https://github.com/anthropics/skills), [OpenAI Skills](https://github.com/openai/skills), and the [OpenKit repository Skills folder](https://github.com/lingkaix/openkit/tree/main/skills), as accepted in [Curated Skill Sources](../decisions/20261017-curated_skill_sources.md). Recommendations are descriptive choices, with no installed record or authority. Users explicitly choose a source and one Skill, load it through existing admission, and select or update retained versions through the existing lifecycle. Custom sources remain supported. No App update automatically loads or refreshes Skills, and no release-bundled Skill feature, generic authoring system or new source registry is introduced. Missing, ambiguous or unavailable sources retain the ordinary admission failure and leave current selection unchanged.

The engineer ruling of 2026-10-16 requires import conventions aligned with [vercel-labs/skills](https://github.com/vercel-labs/skills). An ordinary ecosystem Skill repository must import without an OpenKit manifest or payload rewrite. Supported locators include GitHub `owner/repo` shorthand, GitHub and GitLab repository URLs, plain Git URLs, repository tree URLs selecting one Skill, a local path, and a direct `SKILL.md` or archive URL. Acquisition resolves the selected repository ref to an exact commit before discovery and snapshot admission. A tree URL preserves its selected subpath; repository or named-Skill discovery cannot silently substitute another Skill when selection is missing or ambiguous. Source strings and descriptive metadata never grant host, network, credential or execution authority. A local path is acquired only in the explicitly authorized caller's local filesystem boundary; a remote caller cannot make Core read an arbitrary host path.

Source parsing, discovery and YAML frontmatter handling may port the needed MIT-licensed upstream logic, with its pinned source revision and full license retained in third-party notices. Do not execute `npx skills`, invoke its telemetry or import private CLI internals at runtime. Its package has no supported library entry. Skill discovery recognizes a selected root `SKILL.md`, ordinary `skills/` containers, their `.curated`, `.experimental` and `.system` containers, and ecosystem Agent Skill directories such as `.agents/skills`, `.codex/skills` and `.claude/skills`. Use bounded discovery, skip repository administration and dependency/build directories, and preserve distinct locations when names are ambiguous. Internal Skills (`metadata.internal: true`) stay hidden from ordinary discovery; an explicit authorized selection may include them. Discovery is descriptive and cannot execute package code or follow symlinks.

Accept YAML frontmatter with nonempty string `name` and `description`, including the upstream supported UTF-8 BOM and CRLF forms. Retain the original `SKILL.md` bytes. Ecosystem display names, optional metadata and unknown descriptive fields remain authored content; they need no OpenKit-specific fields and do not select catalog identity or confer permission. In particular, `allowed-tools` and nested metadata cannot grant OpenKit Tools. Do not reject an otherwise valid ecosystem Skill only because its display name differs from its directory or its optional descriptive metadata is not a string map. Invalid YAML, a non-mapping header or missing required strings refuses admission.

Direct downloads are bounded to10MiB, archive expansion to25MiB and archive regular files to1000. The complete selected Skill must also satisfy this owner's16MiB,1024-entry and32-level bounds. Bound streamed downloads before buffering, extraction before writing beyond its bounds, and discovery before unbounded traversal. Archives support ZIP, TAR, TAR.GZ and TGZ; reject traversal, duplicate paths, links and special files before effects. A response without a filename extension is identified from its actual bounded bytes. Failure exposes no partial catalog version and leaves selection unchanged.

Version provenance retains the source locator without embedded credentials, exact resolved commit when the source is Git, selected subpath and OpenKit content digest. Direct downloads and local trees have no fabricated Git commit. The retained version is the launch authority; a lock-style source observation supports an explicit update check without rewriting original provenance. An update check compares a newly resolved source against the retained commit/content identity and reports changed, unchanged or unavailable. It does not import, activate, promote or change a pin. Explicit import still uses ordinary current authority, exact catalog revision, Audit and receipt requirements. Remote outage never changes current selection or prevents retained-version loading. `skills.sh` search is optional future work and remains off by default.

### Payload and deterministic digest

The payload is a directory with valid root `SKILL.md` under the Agent Skills format. Every regular file below it participates, including scripts, references, assets, dotfiles, and licenses. File references resolve from the Skill root. Do not scan Markdown to guess dependencies or silently supply files outside that root. External prerequisites remain authored runtime requirements; a non-self-contained Skill must be repackaged or explicitly report its missing prerequisite.

Initial limits are 16 MiB of file bytes, 1,024 filesystem entries including directories, and 32 directory levels per Skill. Reject oversized trees, absolute paths, empty/dot/parent path segments, backslashes, NUL, ill-formed UTF-8 paths, duplicate paths, symlinks, archive hard links, and entries other than ordinary directories or regular files. Paths use `/` and must already be Unicode NFC; reject rather than rename nonconforming paths. Target-filesystem collisions also fail before launch. Extraction stays inside a fresh assigned root. Admission, hashing, and publication observe the same staged bytes without a source-mutation race. Repository administrative `.git` entries are excluded from the installable tree: Git acquisition selects committed package content, and an uploaded tree containing a `.git` path segment is rejected rather than storing repository history.

`digestFormat` is `openkit-tree-v1`. Hash the ASCII domain `openkit-tree-v1` followed by a zero byte, a four-byte unsigned big-endian entry count, then every directory and regular file below the implicit root ordered lexicographically by unsigned UTF-8 path bytes. Each record contains a four-byte unsigned big-endian path-byte length, path bytes without a trailing slash, one kind byte (`0` for a directory, `1` for a non-executable file, `2` for a file with any executable permission bit), eight-byte unsigned big-endian content length, and exact content bytes. Directories have zero length and no content; include empty directories because a packaged working directory can depend on them. The result is `sha256:` plus 64 lowercase hexadecimal digits. Adapters preserve directories and normalized executability. Ownership, other mode bits, timestamps, and traversal order do not participate; extraction strips special permission bits. Content newlines and Unicode are never normalized. Changing bytes, path, kind, or executability changes identity. A future encoding requires a different named digest format.

Physical Worker delivery uses only the bounded `worker-supply` extension of existing `reference.import` under [Workspace Data Boundary](20260801-nanohost_workspace_data_boundary.md#v1-single-file-effect-transfer). Core verifies the whole captured collection before Sandbox effects; NanoHost and the fixed helper preserve inventory directories and normalized executability; the Worker Shim checks the complete installed source digest before adapter projection. Missing supporting files, empty directories or executable flags fail the same selected-version launch rather than changing the version, reading mutable upstream content or repairing the tree. This transfer grants no new runtime privilege or general mode authority.

### Candidates and review

Authoring happens in normal user or worker work areas. Submission provides a complete bounded tree, entry, exact base digest (null only for a new entry), bounded summary, and optional existing authorized work/evidence references. Producer identity comes from authenticated lineage. An agent submission retains its producing Workspace and Turn and available Artifact references; these explain origin, not improvement quality.

A `SkillCandidate` is a bounded Skill-owner request to select an immutable version. It records exact base/candidate digests, producer, summary, evidence references, and disposition `proposed`, `withdrawn`, `rejected`, or `promoted`. It is not a Knowledge Proposal. Creation changes no default and starts no work. Different bytes or a new base require a new candidate. Rejecting or withdrawing retains lineage; successful promotion fixes its decision actor and audit reference together with the pointer effect. Normal command idempotency handles repeated submission; no candidate queue, runner, or recovery workflow exists.

Only a proposed candidate can be withdrawn, rejected, or promoted; those decisions are terminal and compare the expected candidate/catalog revision. Withdrawal requires the submitting actor's current write authority or the configuration owner; rejection and promotion require current configuration authority. References must resolve to authorized same-Workspace sources, or explicitly visible Server supply, and retain exact ids/digests without copying secret or restricted source payloads into summaries.

An authorized agent may submit under delegated `workspace.write`; this grants no `workspace.configure`, review, launch, or external-effect authority. Imports and direct human edits also produce immutable versions with explicit activation. Content comparison reads exact base/candidate inventories; binary differences show path, size, and digest rather than guessed text. Missing evidence remains visibly unavailable or inconclusive.

The submitting caller is an authorized user or coordinator using the ordinary public operation. A worker without catalog-management authority produces an existing bounded JSON Artifact containing the complete proposed tree, with root-relative directory/file entries, normalized executable flags, and base64 file bytes. The submission request names that Artifact's exact Workspace/id/version/content digest plus the candidate base and summary; the owner validates current access, decodes within both Artifact and Skill bounds, and applies the same tree validation. The selected retained Artifact version remains admissible after a newer head exists, under current source and destination audience checks and exact version/digest validation. Producer and publication Thread/Turn come from that selected version, not the Artifact's original origin or current head; a manual later revision retains its authenticated author while a Worker version retains its actual producing Agent. The authenticated submitter is recorded separately. No host path or model-reported digest substitutes for retained bytes. An explicitly authorized coordinator step may submit it; Artifact appearance alone triggers nothing. This adds no worker management token, private submission route, new output event, or background evaluator.

### Selection, promotion, and rollback

Each entry has one current default; each Workspace has at most one exact pin for an available entry. No current digest means unavailable for ordinary default selection. A pin remains fixed when the entry default advances.

Resolution order is an explicitly authorized exact run selection, an exact version in the composed Agent setup, the Workspace pin, then the entry current digest. A run override may differ from a pin only for that run, must name a Skill already included by the composed setup, must appear in the selection explanation, and changes no pin. Conflicting exact references within composed setup fail `conflict`, not last-writer-wins. An unpromoted candidate requires explicit exact selection and current launch authority; default selection never chooses it automatically.

`turn.start` accepts optional `skillSelections: [{skillId,digest}]`. Each Skill id occurs at most once, each digest is exact, and the request can select only Skills already present in the composed setup. The existing command identity includes the supplied array; the canonical admitted Turn retains it without a separate scheduler selection record. Omission preserves ordinary resolution. AEP resolution rechecks the current composed inclusion and retained snapshot, gives the run selection precedence, and records `selectionSource: run` in its existing supply explanation. This changes neither the default nor a Workspace pin and grants no launch authority.

Promotion and rollback are compare-and-set moves to an existing verified digest, naming expected current digest (including null) and target digest. Candidate promotion also requires its base to equal expected current; stale candidates fail `conflict` without rebasing. Pin set/clear compares the expected prior pin. Clearing a pin returns future resolution to the then-current default. No ranges, implicit upgrades, or automatic promotion policy exist.

Workspace default/pin/activation decisions require `workspace.configure`; Server defaults require deployment-admin authority. Existing audit records retain actor, request, entry, prior/next digest, and candidate/evidence references. Submission is not promotion authority. Any automation requires explicit delegation and current policy rather than a special self-improvement exemption.

### Evaluation and session lineage

Resolved selection records scoped entry id, exact digest and format, selection source, and source plugin membership where applicable. AEP and accepted materialization evidence retain exact inputs; a model naming a Skill is not delivery proof.

Two ordinary authorized work requests may select different versions without moving the shared default. Existing Turn, AEP, Context Package, Artifact, review, audit, and usage owners retain inputs and outcomes. A comparison references both Skill versions and relevant model/runtime/context inputs. This enables A/B analysis without claiming statistical validity or reproducibility of a remote model, external data, or MCP implementation. Evaluation orchestration, held-back checks, scoring, and Judges remain separately deferred.

Selection changes affect later AEP resolution, never files inside an active AgentSession. Changed supply follows the existing new-session/compatibility path. Rollback restores selected Skill content, not external effects, Knowledge, permissions, credentials, or mutable process state.

### Storage, publication, and recovery

The installed snapshot is canonical for retained content; a source locator is provenance and a refresh input, not a mutable launch lookup. It contains no repository history or development working tree. Scope-owned catalog files hold entries, immutable version metadata, candidates, defaults, and Workspace pins. Payload directories are immutable; SQLite indexes are projections, not selection authority. Repeated authorized loads and rollback read retained local bytes without contacting Git or the upstream publisher, preserving loading speed and availability while still verifying integrity and current access. This does not require a separate cache, source mirror, or background preloader.

Use existing single-writer and atomic-file-publication discipline. Mutations carry the normal request id and expected catalog revision. Verify and publish complete payloads before one catalog revision makes their references visible. Never expose partial payloads. Success requires durable required audit and command-receipt evidence; interruption across those stores reports `recovery_required` and preserves actual completed effects. Restart must not choose the newest directory, reset missing authority to empty, reconstruct a receipt from a pointer, or auto-promote. Same-request changed input conflicts; complete stored receipts replay only after current access checks.

Missing/corrupt catalog authority fails closed. Missing/tampered content returns a typed unavailable/integrity result, never another digest, an upstream branch, a developer checkout, or the old static row. Inspection and a new authorized request may retry admission of the same source. Storage exhaustion rejects publication without deleting retained versions automatically.

### Removal and retention

Removal immediately blocks future selection and materialization, including old pins, but retains historical lineage. A normal pointer change leaves admitted sessions fixed. Urgent revocation uses existing stop/access owners and reports uncertainty if teardown cannot be proved; removing a catalog entry cannot erase already read instructions from a process.

Physical purge is distinct from removal. A version required by a live default or pin, proposed candidate, installed or explicitly retained plugin version, unexpired retained AEP/evidence, or legal hold cannot be purged. Terminal candidate and removed-package metadata may retain digest-only history after its content retention obligation ends; that history does not retain bytes forever or claim they remain available. Purge respects existing retention owners and retains minimum unavailable-content lineage. Plugin uninstall does not cascade-delete an independently referenced Skill. No garbage-collection daemon or historical-work rewrite is added.

Portable Workspace export preserves independently readable Skill version bytes, base and candidate history through `docs/specs/20260704-workspace_backup_export_import.md`; it restores no source default, pin, or review authority. Imported candidate content requires a fresh target submission before a decision. Complete data-root backup preserves same-deployment state.

### Management surface

The transport-neutral operation catalog exposes entry/version list and read, exact content/diff reads, create/import, candidate submit/withdraw/decide, default selection, pin set/clear, remove, and explicit unreferenced purge. App API, Core Client, OpenAPI, and remote MCP and the administrator CLI project those same operations. Workspace reads require `workspace.read`; candidate submission and its validated inactive payload require `workspace.write`; ordinary catalog creation/import, activation, promotion, pins, removal, and purge require `workspace.configure`. Withdrawal follows the candidate rule above. Resource sensitivity may further restrict reads. Server mutation, other Workspaces, Vault use, and worker launch never follow implicitly.

## Proposed Design

Reuse NanoCore storage, command, permission, audit, composed setup, AEP, and runtime adapter owners. One Skill catalog module owns its records and selection; payload admission is shared with package import using the digest above. A bounded candidate record preserves exact base, bytes, and decision without another evaluation lifecycle. Do not duplicate file validation or create a Skill runtime.

## Current Implementation Projection

The native API and CLI expose version inspection, update checks, comparison, removal, purge and candidate withdrawal. The prepared Web Catalog source projects those operations through retained Skill history, exact file downloads, inventory comparison, source checks, explicit removal and confirmed purge, and candidate withdrawal. Existing Catalog import, candidate decision, default selection and pin controls retain their ordinary behavior and current pointer checks. Publication remains pending actual P20 main integration and the final Web checks; this source preparation establishes no physical Worker delivery or real-use acceptance.

The migrated resource and Agent catalog families use the canonical definition-derived `client.operations` map, JSON bindings and MCP/CLI projections under [Operation Definition](20261002-operation_definition.md). Native catalog, selection, supply and authorization owners retain their existing outcomes; former routes and client namespaces are absent.

Workspace Skill versions, candidates, pins, and current selection live in `workspaces/<id>/catalog/catalog.json` with immutable snapshot trees under `catalog/skill-snapshots/`. App API, Core Client, CLI, and the Web Catalog screen expose ordinary-user import, candidate, pin, and selection operations. AEP supply resolves catalog pins or current digests onto the AgentSession-private `worker-supply` root; the Codex thin adapter projects those imported trees into `$CODEX_HOME/skills`. Native plugin loading and a retained real-worker combined Skill/MCP story are not yet advertised.

The ordinary `turn.start` entry retains exact per-run Skill selectors on its canonical Turn. The existing Worker AEP resolver consumes that input and preserves current catalog integrity, removal and payload-availability checks; no second selection store or work runner is added. Native modeled-Worker regressions cover distinct exact selections and unchanged shared pointers, but make no physical Worker or real-use acceptance claim.

Native admission retains the original package digest, member key and source subpath, or a candidate's exact base. Same-entry identical bytes return retained version facts. Candidate content and request publish in one catalog revision. Version inspection, exact file reads and inventory comparison use verified retained snapshots. Selection and pin updates reject changed bytes and compare explicit public prior digests. Removal clears the default and retains historical bytes. Native mutations use existing command receipts and Workspace Audit with current actor admission. Artifact-origin submission checks the exact retained Artifact version, its tree digest, current disclosure and producer lineage before creating a candidate. Purge joins the existing unexpired AEP and evidence retention owners and refuses unavailable authority. The existing version record separates retained or purged payload availability from immutable identity and provenance. Portability retains purged metadata without claiming missing retained bytes are purged. Authorized identical-byte admission restores payload availability and keeps original version facts. Physical Worker delivery of complete directories and executable files and the retained real-worker consumption story remain completion requirements.

Ecosystem imports use the source, discovery and frontmatter conventions recorded above without running the upstream CLI. Native Git and bounded direct Skill/archive acquisition retain the actual resolved commit when one exists and the verified content digest. Local CLI import stages the same strict tree and submits one public import; Core accepts no caller-local path. An explicit update check compares retained source provenance with current upstream bytes and reports changed, unchanged or unavailable without importing, activating or moving a pin.

The target uses the existing server and Workspace storage owners with a canonical catalog document per owner scope, immutable installed payload directories, and derived indexes. `docs/specs/20260703-storage_layout_record_ownership.md` owns their physical layout; implementation must project these accepted contracts into the existing schemas and storage modules.

## Alternatives Considered

Plugin-owned versions obstruct independent Skill improvement. Publisher labels alone cannot verify bytes. Git-only locators with an evictable cache make loading and rollback depend on source availability; bounded canonical installed snapshots avoid that dependency within ordinary product storage. A dedicated experiment platform is unnecessary for candidate submission, exact runs, and pointer rollback.

## Consequences

Skill evolution is independent while package provenance and exact worker inputs remain traceable. Retained snapshots consume storage and require explicit purge. A Skill digest identifies supplied files, not all external dependencies or model behavior.

## Rollout / Migration Plan

Implement bounded snapshot storage under `docs/core/storage.md` and `docs/specs/20260703-storage_layout_record_ownership.md`. Retain exact source lineage without importing editable source repositories or Git history, and verify local immutable bytes on supply and rollback.

Replace the hardcoded metadata table directly, implement the setup/AEP exact references, management, and verified publication, and prove real worker consumption. Retain no compatibility reader for the static row. Complete the companion plugin/MCP story before claiming the requested full worker-resource capability.

## Testing Strategy / Acceptance Criteria

Retained catalog, producer, version, inventory, entry, pin, candidate and plugin membership observations ignore and preserve owned descriptive additions on normal revision-protected rewrites. Public and selected Worker supply carry only known fields, and annotations do not change historical tree or version digests. Executable supply and effect-facing selection or binding authority remain exact; tree integrity and stale-revision refusals remain required.

1. Known vectors prove framing and byte ordering. File, supporting-resource, path, empty-directory, and executable changes change identity; timestamps and traversal order do not. Unsafe, oversized, racing, and target-colliding trees cannot publish or escape.
2. A plugin-imported Skill gains an independent candidate without changing its original membership or another Skill. Re-import is idempotent; reused labels with different bytes remain distinguishable.
3. Candidates change no default; unauthorized promotion fails; valid promotion succeeds; stale/concurrent updates conflict; pins survive default advancement.
4. Two authorized runs use different exact versions with distinguishable AEP/materialization traces and unchanged defaults/pins. Rollback loads retained earlier bytes while upstream is unavailable.
5. Restart/interruption preserves complete authority or reports `recovery_required`; corrupt content has no fallback. Removal blocks admission and referenced/held bytes cannot be purged.
6. One real supported worker discovers a Skill, reads a supporting file, and produces an artifact whose content depends on the selected version. Metadata-only copying, model self-report, and a skipped real check are insufficient. The plugin spec supplies the combined Skill/MCP story; no Evaluation Harness is required.

## Risks & Mitigations

Skill instructions/scripts remain subordinate to authored setup, current permission, and sandbox controls. Experimental metadata such as `allowed-tools` grants no OpenKit authority. Installed resources are read-only; outputs use declared work areas. Candidate claims, observed outcomes, and authorized promotion remain distinguishable.

## Memory And Knowledge Learning Inputs

`20260909-personal_memory_and_knowledge_learning.md` may route procedural learning to this existing SkillCandidate owner. Personal preferences and factual Knowledge remain in their notebook; a Skill is instructions plus optional supporting files/code, not another notebook scope. Source-private content cannot leak through candidate descriptions, packaged files or evaluation evidence. Automatic candidate generation/evaluation changes no current digest; authorized promotion, pins, exact work evidence and rollback retain this specification's semantics. A/B comparison remains distinct from an implemented experiment scheduler or autonomous promotion policy.

The engineer rulings of 2026-10-17 supersede the earlier product-authoring increment: OpenKit does not build a generic Skill author, and the unlanded openkit-bwm-author package is excluded. A future OpenKit-fitted BWM Meta-Skill remains an ordinary Skill and waits for its separate coordinator brief. An authorized Task or Goal may still produce an attributable candidate Artifact; explicit submission creates the existing SkillCandidate, and human decisions and pins select retained versions. Add no BWM Core entity, evaluator, automatic promotion, background runner or alternate authority. B01 synthetic school-admissions intake and MCP stubs live outside the public repository. Real-use acceptance cannot be inferred from synthetic inputs, fake execution or candidate existence.

The general native candidate-loop regression uses test-only Skill fixtures through real Task admission, Worker-output Artifact retention, exact Artifact-origin candidate submission, human promotion and pinning, and a later Task's exact AEP selection. It does not distribute an authoring Skill or prove physical Worker delivery or real-use acceptance. Existing catalog and Task owners retain all runtime behavior.

## Deferred / Future Work

Experiment scheduling, statistical analysis, held-back evaluation suites, autonomous promotion policy, business-model representations, generic proposals, registry search, source hosting, version ranges, and cross-deployment distribution remain separate work.

## Internal Assistant Consumer

`20260909-internal_agent_resource_integration.md` owns metadata-first selection and bounded `skill.read` for the internal Assistant. It resolves this catalog's exact retained versions/pins and source restrictions directly without an AEP or another version authority. Current removal/eligibility changes invalidate later reads even when bytes remain retained for evidence. Reading an immutable snapshot does not install or execute its scripts; Worker execution and materialization retain their existing owners. The consumer uses the catalog's verified retained snapshot reader for metadata-first selection and bounded file reads, with current removal and payload-availability checks. This does not expand other internal roles' Tool sets or establish Worker delivery acceptance.

## Related Specifications And Sources

- `docs/specs/20260907-agent_plugin_packaging_and_worker_supply.md`
- `docs/specs/20260907-mcp_catalog_management.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260703-agent_manifest_aep_resolution.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260711-evaluation_harness_design.md`
- `docs/specs/20260710-self_improvement_evaluation_loop.md`
- `docs/specs/20261002-remote_mcp_interface.md`
- `docs/specs/20260529-test_strategy.md`
- [Agent Skills format](https://agentskills.io/specification).
- [skills local hash implementation](https://github.com/vercel-labs/skills/blob/main/src/local-lock.ts), evidence for content identification rather than OpenKit's encoding or a runtime dependency.
