---
status: Accepted
implementation: Implemented
kind: concept
aspect: agent-supply
---

# Skill Catalog Versioning And Pinning

This specification owns Skill identity, immutable versions, exact selection, pins, and bounded-tree digests.

## Scope

Owns:

- Skill catalog identity, candidate review, exact selection, pins, tree digests, and selected-version delivery integrity.

Does not own:

- Plugin packaging and MCP configuration versions. Their catalog specifications own them.
- Skill execution, privileges, and credentials. The runtime and Policy owners keep them.
- Experiment scheduling and scoring. That work remains [#313](https://github.com/lingkaix/openkit/issues/313).
- Knowledge proposal semantics. The notebook owners keep them.
- Assistant `skill.read`. [Internal Agent Resource Integration](20260909-internal_agent_resource_integration.md) owns that read.

Core:

- [Doctrine](../core/doctrine.md), [Agent supply](../core/agent-supply.md), [Storage](../core/storage.md), [Policy](../core/policy.md), and [Evidence](../core/evidence.md).

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

The engineer ruling of 2026-10-16 requires import conventions aligned with [vercel-labs/skills](https://github.com/vercel-labs/skills). An ordinary ecosystem Skill repository must import without an OpenKit manifest or payload rewrite. Supported locators include GitHub `owner/repo` shorthand, GitHub and GitLab repository URLs, plain Git URLs, repository tree URLs selecting one Skill, a local path, and a direct `SKILL.md` or archive URL. Acquisition resolves the selected repository ref to an exact commit before discovery and snapshot admission. A tree URL preserves its selected subpath; repository or named-Skill discovery cannot silently substitute another Skill when selection is missing or ambiguous. Source strings and descriptive metadata never grant host, network, credential or execution authority. A local path is acquired only in the explicitly authorized caller's local filesystem boundary; a remote caller cannot make Core read an arbitrary host path. The local CLI stages that tree and submits one public import. Core does not accept a caller-local path.

Source parsing, discovery and YAML frontmatter handling may port the needed MIT-licensed upstream logic, with its pinned source revision and full license retained in third-party notices. Do not execute `npx skills`, invoke its telemetry or import private CLI internals at runtime. Its package has no supported library entry. Skill discovery recognizes a selected root `SKILL.md`, ordinary `skills/` containers, their `.curated`, `.experimental` and `.system` containers, and ecosystem Agent Skill directories such as `.agents/skills`, `.codex/skills` and `.claude/skills`. Use bounded discovery, skip repository administration and dependency/build directories, and preserve distinct locations when names are ambiguous. Internal Skills (`metadata.internal: true`) stay hidden from ordinary discovery; an explicit authorized selection may include them. Discovery is descriptive and cannot execute package code or follow symlinks.

Accept YAML frontmatter with nonempty string `name` and `description`, including the upstream supported UTF-8 BOM and CRLF forms. Retain the original `SKILL.md` bytes. Ecosystem display names, optional metadata and unknown descriptive fields remain authored content; they need no OpenKit-specific fields and do not select catalog identity or confer permission. In particular, `allowed-tools` and nested metadata cannot grant OpenKit Tools. Do not reject an otherwise valid ecosystem Skill only because its display name differs from its directory or its optional descriptive metadata is not a string map. Invalid YAML, a non-mapping header or missing required strings refuses admission.

Direct downloads are bounded to 10 MiB. Archive expansion is bounded to 25 MiB. An archive may contain 1,000 regular files. Discovery itself admits at most 10,000 header inventory entries and 25 MiB of aggregate header bytes before source selection. An unsupported, ambiguous, or oversized discovery publishes no version. The complete selected Skill must also satisfy this owner's16MiB,1024-entry and32-level bounds. Bound streamed downloads before buffering, extraction before writing beyond its bounds, and discovery before unbounded traversal. Archives support ZIP, TAR, TAR.GZ and TGZ; reject traversal, duplicate paths, links and special files before effects. A response without a filename extension is identified from its actual bounded bytes. Failure exposes no partial catalog version and leaves selection unchanged.

Version provenance retains the source locator without embedded credentials, exact resolved commit when the source is Git, selected subpath and OpenKit content digest. Direct downloads and local trees have no fabricated Git commit. The retained version is the launch authority; a lock-style source observation supports an explicit update check without rewriting original provenance. An update check compares a newly resolved source against the retained commit/content identity and reports changed, unchanged or unavailable. It does not import, activate, promote or change a pin. Explicit import still uses ordinary current authority, exact catalog revision, Audit and receipt requirements. Remote outage never changes current selection or prevents retained-version loading. Registry search, including skills.sh, is not an admitted source ([#362](https://github.com/lingkaix/openkit/issues/362)). There is no hidden search switch.

### Payload and deterministic digest

The payload is a directory with valid root `SKILL.md` under the Agent Skills format. Every regular file below it participates, including scripts, references, assets, dotfiles, and licenses. File references resolve from the Skill root. Do not scan Markdown to guess dependencies or silently supply files outside that root. External prerequisites remain authored runtime requirements; a non-self-contained Skill must be repackaged or explicitly report its missing prerequisite.

Initial limits are 16 MiB of file bytes, 1,024 filesystem entries including directories, and 32 directory levels per Skill. Each UTF-8 path is at most 4,096 bytes. `packages/config-schema/src/tree-digest.ts` owns this validator. Reject oversized trees, absolute paths, empty/dot/parent path segments, backslashes, NUL, ill-formed UTF-8 paths, duplicate paths, symlinks, archive hard links, and entries other than ordinary directories or regular files. Paths use `/` and must already be Unicode NFC; reject rather than rename nonconforming paths. Target-filesystem collisions also fail before launch. Extraction stays inside a fresh assigned root. Admission, hashing, and publication observe the same staged bytes without a source-mutation race. Repository administrative `.git` entries are excluded from the installable tree: Git acquisition selects committed package content, and an uploaded tree containing a `.git` path segment is rejected rather than storing repository history.

[Protocol Identifiers And Enums](20261021-protocol_identifiers_and_enums.md) owns shared canonical JSON. This tree digest is a named exception. It uses the binary framing below, not that JSON form. `digestFormat` is `openkit-tree-v1`. Hash the ASCII domain `openkit-tree-v1` followed by a zero byte, a four-byte unsigned big-endian entry count, then every directory and regular file below the implicit root ordered lexicographically by unsigned UTF-8 path bytes. Each record contains a four-byte unsigned big-endian path-byte length, path bytes without a trailing slash, one kind byte (`0` for a directory, `1` for a non-executable file, `2` for a file with any executable permission bit), eight-byte unsigned big-endian content length, and exact content bytes. Directories have zero length and no content; include empty directories because a packaged working directory can depend on them. The result is `sha256:` plus 64 lowercase hexadecimal digits. Adapters preserve directories and normalized executability. Ownership, other mode bits, timestamps, and traversal order do not participate; extraction strips special permission bits. Content newlines and Unicode are never normalized. Changing bytes, path, kind, or executability changes identity. A future encoding requires a different named digest format.

The Codex adapter delivers the selected version by the native extra-roots call with the exact selected target paths. It does not copy trees into a global native skills directory. Physical Worker delivery uses only the bounded `worker-supply` extension of existing `reference.import` under [Workspace Data Boundary](20260801-nanohost_workspace_data_boundary.md#v1-single-file-effect-transfer). Core verifies the whole captured collection before Sandbox effects; NanoHost and the fixed helper preserve inventory directories and normalized executability; the Worker Shim checks the complete installed source digest before adapter projection. Missing supporting files, empty directories or executable flags fail the same selected-version launch rather than changing the version, reading mutable upstream content or repairing the tree. This transfer grants no new runtime privilege or general mode authority.

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

New native Workspace pin publications retain `pinAuditRef`, the identifier of the existing command admission Audit event that precedes that catalog publication. A new command that pins the same digest replaces this attribution; receipt replay preserves the winning publication. Pins without retained attribution remain unknown, and clearing a pin removes its live reference without deleting Audit history. The catalog read projection exposes this reference. When a Workspace pin wins Worker selection, the retained AEP Skill lineage carries its reference so a later pin change cannot change historical attribution. Run or composed exact selection and current-default selection do not claim pin attribution. These references supply evidence, never authority, and portable source pins remain historical rather than target selection.

### Evaluation and session lineage

Resolved selection records scoped entry id, exact digest and format, selection source, and source plugin membership where applicable. AEP and accepted materialization evidence retain exact inputs; a model naming a Skill is not delivery proof.

Two ordinary authorized work requests may select different versions without moving the shared default. Existing Turn, AEP, Context Package, Artifact, review, audit, and usage owners retain inputs and outcomes. A comparison references both Skill versions and relevant model/runtime/context inputs. This enables A/B analysis without claiming statistical validity or reproducibility of a remote model, external data, or MCP implementation. Evaluation orchestration, held-back checks, scoring, and Judges remain separate work ([#313](https://github.com/lingkaix/openkit/issues/313)). This catalog does not run that scheduler.

Selection changes affect later AEP resolution, never files inside an active AgentSession. Changed supply follows the existing new-session/compatibility path. Rollback restores selected Skill content, not external effects, Knowledge, permissions, credentials, or mutable process state.

### Storage, publication, and recovery

Retained catalog, producer, version, inventory, entry, pin, candidate and plugin membership observations ignore and preserve owned descriptive additions on normal revision-protected rewrites. Public and selected Worker supply carry only known fields, and annotations do not change historical tree or version digests. Executable supply and effect-facing selection or binding authority remain exact; tree integrity and stale-revision refusals remain required.

The installed snapshot is canonical for retained content; a source locator is provenance and a refresh input, not a mutable launch lookup. It contains no repository history or development working tree. Scope-owned catalog files hold entries, immutable version metadata, candidates, defaults, and Workspace pins. Payload directories are immutable; SQLite indexes are projections, not selection authority. Repeated authorized loads and rollback read retained local bytes without contacting Git or the upstream publisher, preserving loading speed and availability while still verifying integrity and current access. This does not require a separate cache, source mirror, or background preloader.

Skill management write requests limit ASCII catalog identifiers to 255 characters and import display names to 256 Unicode code points; retained catalog readers preserve their existing identifiers and labels.

Use existing single-writer and atomic-file-publication discipline. Mutations carry the normal request id and expected catalog revision. Verify and publish complete payloads before one catalog revision makes their references visible. Never expose partial payloads. Success requires durable required audit and command-receipt evidence; interruption across those stores reports `recovery_required` and preserves actual completed effects. Restart must not choose the newest directory, reset missing authority to empty, reconstruct a receipt from a pointer, or auto-promote. Same-request changed input conflicts; complete stored receipts replay only after current access checks.

Missing/corrupt catalog authority fails closed. Missing/tampered content returns a typed unavailable/integrity result, never another digest, an upstream branch, a developer checkout, or the old static row. Inspection and a new authorized request may retry admission of the same source. Storage exhaustion rejects publication without deleting retained versions automatically.

### Removal and retention

Removal immediately blocks future selection and materialization, including old pins, but retains historical lineage. A normal pointer change leaves admitted sessions fixed. Urgent revocation uses existing stop/access owners and reports uncertainty if teardown cannot be proved; removing a catalog entry cannot erase already read instructions from a process.

Physical purge is distinct from removal. A version required by a live default or pin, proposed candidate, installed or explicitly retained plugin version, unexpired retained AEP/evidence, or legal hold cannot be purged. Terminal candidate and removed-package metadata may retain digest-only history after its content retention obligation ends; that history does not retain bytes forever or claim they remain available. Purge respects existing retention owners and retains minimum unavailable-content lineage. Plugin uninstall does not cascade-delete an independently referenced Skill. No garbage-collection daemon or historical-work rewrite is added.

Portable Workspace export preserves independently readable Skill version bytes, base and candidate history through `docs/specs/20260704-workspace_backup_export_import.md`; it restores no source default, pin, or review authority. Imported candidate content requires a fresh target submission before a decision. Complete data-root backup preserves same-deployment state.

### Management surface

The transport-neutral operation catalog exposes entry/version list and read, exact content/diff reads, create/import, candidate submit/withdraw/decide, default selection, pin set/clear, remove, and explicit unreferenced purge. App API, Core Client, OpenAPI, remote MCP and the administrator CLI project those same operations. For desktop agent Skill delivery, remote MCP alone searches authorized Workspace catalog metadata and reads immutable Skill digests on demand. An exact Skill content read of `SKILL.md` adds its readable root and the admitted file inventory as supplemental MCP content alongside the unchanged operation result. Other content reads return only the selected file; file reads use the same exact digest and never execute scripts. The Skill version metadata read retains its contract even when bytes are unavailable. This projection does not change Skill formats, pin semantics, owner admission or Worker delivery. Workspace reads require `workspace.read`; candidate submission and its validated inactive payload require `workspace.write`; ordinary catalog creation/import, activation, promotion, pins, removal, and purge require `workspace.configure`. Withdrawal follows the candidate rule above. Resource sensitivity may further restrict reads. Server mutation, other Workspaces, Vault use, and worker launch never follow implicitly.

## Memory And Knowledge Learning Inputs

`20260909-personal_memory_and_knowledge_learning.md` may route procedural learning to this existing SkillCandidate owner. Personal preferences and factual Knowledge remain in their notebook; a Skill is instructions plus optional supporting files/code, not another notebook scope. Source-private content cannot leak through candidate descriptions, packaged files or evaluation evidence. Automatic candidate generation/evaluation changes no current digest; authorized promotion, pins, exact work evidence and rollback retain this specification's semantics. A/B comparison remains distinct from an implemented experiment scheduler or autonomous promotion policy.

The engineer rulings of 2026-10-17 supersede the earlier product-authoring increment: OpenKit does not build a generic Skill author, and the unlanded openkit-bwm-author package is excluded. A future OpenKit-fitted BWM Meta-Skill remains an ordinary Skill and waits for its separate coordinator brief. An authorized Task or Goal may still produce an attributable candidate Artifact; explicit submission creates the existing SkillCandidate, and human decisions and pins select retained versions. Add no BWM Core entity, evaluator, automatic promotion, background runner or alternate authority. Synthetic intake fixtures and MCP stubs live outside the public repository. Real-use acceptance cannot be inferred from synthetic inputs, fake execution or candidate existence.

The general native candidate-loop regression uses test-only Skill fixtures through real Task admission, Worker-output Artifact retention, exact Artifact-origin candidate submission, human promotion and pinning, and a later Task's exact AEP selection. It does not distribute an authoring Skill or prove physical Worker delivery or real-use acceptance. Existing catalog and Task owners retain all runtime behavior.

## Internal Assistant Consumer

`20260909-internal_agent_resource_integration.md` owns metadata-first selection and bounded `skill.read` for the internal Assistant. It resolves this catalog's exact retained versions/pins and source restrictions directly without an AEP or another version authority. Current removal/eligibility changes invalidate later reads even when bytes remain retained for evidence. Reading an immutable snapshot does not install or execute its scripts; Worker execution and materialization retain their existing owners. The consumer uses the catalog's verified retained snapshot reader for metadata-first selection and bounded file reads, with current removal and payload-availability checks. This does not expand other internal roles' Tool sets or establish Worker delivery acceptance.

## Acceptance

One real supported worker discovers a Skill, reads a supporting file, and produces an artifact whose content depends on the selected version. Copying metadata only, a model self-report, or a skipped real check is not sufficient. The plugin specification supplies the combined Skill and MCP story.

## Implementation

- `apps/nanocore/src/catalog/`
- `apps/nanocore/src/runtime/`
- `packages/config-schema/src/`
- `packages/app-api-schemas/src/`
- `packages/worker-shim/src/`

## Implementation Gaps

None.

## Decisions

- [Ecosystem Skill import and local staging](../decisions/20261016-ecosystem_skill_import_and_local_staging.md)
- [Curated Skill sources](../decisions/20261017-curated_skill_sources.md)
