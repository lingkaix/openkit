---
date: "2026-10-24"
---
# Independent Documentation Audit: Agent-Supply Group

This non-authorizing record holds the agent-supply group of the [independent documentation audit](20261023-independent_doc_audit.md). Its owning rule is [Change Execution Governance](../change-execution.md). It records observations, dispositions, and questions. It does not authorize design.

## Scope And Base

- Group base SHA: `b648f860e3eeab8bf1a7a419f16b674882ed7a55` (`main` on 2026-10-24, after four code changes since the mediation base). Issue #440 had no comments and held no group in this scope. The inspectors read the tree at `314f72fe2e62864b34eb30a155488c4507b80553`; the auditor checked each kept finding again at the group base, where `apps/nanocore/src/catalog/resource-catalog.ts`, `packages/config-schema/`, and the cited runtime files are unchanged.
- Core document: `docs/core/agent-supply.md`.
- Specifications: `20260616-agent_environment_package.md` (AEP), `20260703-agent_manifest_aep_resolution.md` (MAR), `20260711-skill_catalog_versioning_pinning.md` (SKL), `20260907-agent_plugin_packaging_and_worker_supply.md` (PLG), `20260907-mcp_catalog_management.md` (MCC), and `20260704-workspace_data_source_catalog.md` (DSC).
- G3 inspection: three read-only inspector contexts (AS-AEP for AEP and MAR; AS-SKL for SKL and PLG; AS-MCC for MCC and DSC). They read code only and ran no tests. The auditor verified each kept finding against the code.
- Hand-off received from the vault group: `20260703-agent_manifest_aep_resolution.md:486` (runtime-file drift). Resolved below.

## G2 Core Against Specifications

- AS-G2-01: Core Agent Supply line 216 keeps `ready`, `degraded`, `blocked`, `disabled`, and `unknown` as the internal resolution vocabulary and says product-visible records project only a readiness and health summary under the protocol owner. MAR Readiness States calls readiness product-visible with `ready`, `degraded`, `blocked`, and `stale`, and MAR Resolved Decisions calls them target states. The code has the five Core values and no `stale` (`apps/nanocore/src/agents/readiness.ts:6`). Question Q-113.
- AS-G2-02: Core line 33 says a package is not another authored setup or runtime authority; PLG lets authored setup reference an installation that expands to member references only. Compatible; no action.
- AS-G2-03: Core line 263 requires strict validation of authority-bearing fields; MAR line 305 lists `providers` among sections whose new fields are authority-bearing, while the version 4 schema forbids `providers` (`packages/config-schema/src/agent.ts:270`, `agent-environment.ts:1149`). The rule is vacuous for a forbidden section, and it is recorded with Q-115 rather than edited.

## G3 Specifications Against Implementation

| Finding | Clause | Evidence (at the group base SHA) | Adjudication | Action |
| --- | --- | --- | --- | --- |
| AS-PLG-03, 04, 06 | PLG: immutable source provenance; different-source collision fails with a remapping requirement, never lossy normalization; an overridden changed member fails `conflict` on update | `apps/nanocore/src/catalog/resource-catalog.ts:1714-1722` lossy id derivation; `:330-380` reuses the existing entry; `:1127` writes null provenance; `:1130-1144` moves the installation without a member delta | Code differs from a current accepted document | Issue #486 (blocking candidate: retained data) |
| AS-PLG-01, 02, 05, 08 | PLG grouped management, setup expansion, narrow-boundary admission | `packages/app-api-schemas/src/catalog-operations.ts` has only `catalog.plugin-list` and `catalog.plugin-import`; no non-test reader in `apps/nanocore/src/agents/`; whole import fails on one invalid component | Accepted behavior not implemented, and the projection did not say so | Issue #487 (enhancement); the PLG projection now names the gaps and both issues |
| AS-MCC-05, 06 | MCC: format version check, no guessed SSE fallback, contained explicit `cwd` | `resource-catalog.ts:1596-1643` maps every `url` to `http` and copies `cwd`; `apps/nanocore/src/runtime/worker-mcp-gateway.ts:540-567` spawns with it | Code differs from a current accepted document | Issue #488 |
| AS-MCC-02, 03, 07 | MCC: distinct stage-version and remove effects; selection compares expected current digest; removal blocks selection | Workspace operations are list, create, select, binding only; `SelectMcpVersionRequestSchema` has no digest; `selectMcpVersion` and `updateMcpBinding` ignore `removed` | Code differs from a current accepted document | Issue #489 |
| AS-MCC-04 | MCC: installation-scoped `packageDataKey` | `resource-catalog.ts:1238-1240` keys by entry id | Code differs from a current accepted document | Issue #490 |
| AS-MAR-02 | AEP: an exact `{host, port}` build egress grant | `packages/config-schema/src/agent-environment.ts:265-272`, `agent.ts:49-56` accept any host without `*`; NanoHost builds `{host}:{port}` (`apps/nanohost/src/main.rs:577-594`) and `validate_egress_grant` accepts the `https://host/path` form, so a URL-form host passes both layers | Code differs from a current accepted document | Issue #491, with a comment that raises its severity hint to ordinary |
| AS-MCC-01 | MCC: discovery follows up to sixty-four pages | `worker-mcp-gateway.ts:34,515` pass `listMaxPages: 64` to the MCP SDK client, which paginates inside `listTools` | Inspector false positive | No action |
| AS-MAR-01 | MAR projection: NanoHost carries runtime-file credentials to their sink | `apps/nanocore/src/runtime/turn-executor-factory.ts:6218-6227` (`nanoHostRuntimeCredentialImports`) rejects runtime-file materialization on persistent Worker images | Projection drift; the capability gap is issue #480 | Corrected |
| AS-AEP-01 | AEP projection: persistent Skill versions and the `worker-supply` inventory are not implemented | `packages/config-schema/src/agent-environment.ts:466-501`; `apps/nanocore/src/runtime/worker-governance-backend.ts:380-385,530-575` import verified Skill snapshots | Projection drift; the Worker Shim also verifies each installed Skill tree digest (`packages/worker-shim/src/turn.ts:1193-1215`); MCP versions in the inventory, Plugin expansion, and native materialization of MCP and Plugin resources stay unimplemented | Corrected |
| AS-AEP-02 | AEP line 98: "an implementation divergence recorded below" | AEP line 315 says the resolver retains no concrete Provider summary | Projection drift inside the document | Corrected |
| AS-AEP-02 other | AEP: direct Provider authority fails before child launch | The schema still has `direct-external` and `direct-provider` arms; the resolver always requires the trusted relay | Not decided whether the arms stay | Question Q-114 |
| AS-AEP-03 | AEP No widen of the sandbox: the package's `providers` section | Version 4 forbids `providers` (`agent-environment.ts:1149`) | Inside-document drift against the version 4 envelope | `providers` removed from the bound; the bound itself is kept |
| AEP G5 | AEP line 176: a line-number reference `agent-environment.ts:445` | The line moved to 593 | Writing rule | Line number removed |
| AS-MAR-03 | MAR Materialization: "provider endpoint config" | Workers receive only the `/inference/*` Gateway binding | Not decided whether the bullet means the Gateway endpoint | Question Q-115 |
| AS-DSC-01 | DSC: narrowing, Policy denial, and missing grant produce blocked diagnostics with remediation categories | `packages/config-schema/src/source-catalog.ts:256-286` has no such inputs; all refusals become `workspace_data_source_blocked` | Accepted behavior not implemented under `implementation: Partial`; the projection did not say so | Projection now states the gap |
| AS-DSC-02 | DSC: rows that touch a source carry its id | `apps/nanocore/src/capability/usage-ledger.ts:122,385` accept and normalize `sourceIds`; every producer passes `[]` | No producer touches a catalog source today | Question Q-120 |
| AS-DSC-03 | DSC: a network-addressable Git URL and commit pin | `source-catalog.ts:185-223` accepts exactly `https:` with `url` and `commit` | Not decided | Question Q-119 |
| AS-SKL-06 | SKL: Git acquisition excludes `.git`; an uploaded tree containing `.git` is rejected | `packages/config-schema/src/tree-digest.ts` skips `.git` in a directory walk; `validateTreePath` rejects it in an entry list | Match | No action |
| AS-SKL-05 | SKL: 32 directory levels allowed | `tree-digest.ts:120-121` rejects a directory at depth 32 in the walk; `validateTreePath` (`:206`) allows 32 segments | Code differs from a current accepted document | Issue #492 (low) |
| AS-SKL-03, 02 | SKL: conflicting exact references fail `conflict`; promotion names the expected current digest | `apps/nanocore/src/agents/setup-resolver.ts:220-228` emits the error diagnostic `agent_setup.conflicting_skill_versions`; `decideWorkspaceSkillCandidate` checks the digest only when the key is present | Outcome naming and an optional field; not decided | Question Q-117 |
| AS-MCC-06 other | PLG Import and package admission: an unsupported component is reported at its narrow boundary and other valid components remain importable; MCC: import remains inert | `resource-catalog.ts:1622-1631` refuses the whole plugin for `auth` or `query`; the MCC projection describes that current refusal truthfully | Code differs from a current accepted document | Issue #487, with a comment that names this case |
| AS-SKL-01 | SKL: withdrawal by the submitter or the configuration owner | Behavior matches; only the operation description names the submitter | Code description text | No action |
| AS-MCC-08 | MCC: canonical JSON rejects non-finite values | Every caller parses with the strict schema first | Match | No action |
| AS matches | AEP envelope, build bounds, byte projection, fixed command; MAR manifest refusals, native environment limits, built-in grant templates; SKL digest, bounds, resolution order, run selection, candidates, purge, pins, permission tiers; PLG digest and membership map; MCC version identity, scope, composition, Server mutations, presentation, placeholders, redirects; DSC schema, resolver refusals, orchestration, snapshot, authority audit | The inspectors' tallies in the audit working space | Match | None |

Frontmatter `updated` values of MCC and DSC are older than their latest content. The audit does not change `updated` dates; no action.

## G4 Organization

No move, merge, or split is applied.

## G5 Writing

- History and draft wording in Accepted text: SKL "The earlier Draft preserved useful integrity, pointer, pin, AEP, and restart constraints" and "This contract replaces the earlier future-only entry conditions". Question Q-121.
- Change-record status in projections: SKL "Publication remains pending actual P20 main integration" and "The prepared Web Catalog source"; MAR "The 2026-07-21 refreshed arm64 images build locally" and the A1 qualification sentence. Question Q-121.
- Experience-chosen numbers not marked as a current default: SKL download, archive, and tree limits (also missing spaces, as "bounded to10MiB"); PLG "64 MiB ... 4,096 filesystem entries"; MCC "at most thirty seconds, sixty-four discovery pages and a 512KiB tool-list bound"; MAR native environment 128-entry and 16 KiB limits. Question Q-121.
- Time-relative text: DSC "Today the only place that can describe such a source ..." and "accepted V1 defaults". Question Q-121.

## Semantic Preservation

The inventory tool compared each changed file with the group base.

| File | Normative sentences | Numbers | Backticked identifiers | Headings | Links |
| --- | --- | --- | --- | --- | --- |
| `20260703-agent_manifest_aep_resolution.md` (MAR) | 150 unchanged | 4 unchanged | 259 unchanged, 1 added | 33 unchanged | 18 unchanged |
| `20260616-agent_environment_package.md` (AEP) | 99 unchanged, 1 changed (No widen bound without `providers`) | 5 unchanged | 220 unchanged, 2 removed (the stale line reference and `providers`), 3 added | 19 unchanged | 22 unchanged |
| `20260907-agent_plugin_packaging_and_worker_supply.md` (PLG) | 49 unchanged, 1 added (a projection sentence that states the import gaps) | 2 unchanged | 39 unchanged, 2 added | 25 unchanged | 5 unchanged |
| `20260704-workspace_data_source_catalog.md` (DSC) | 36 unchanged | 0 | 108 unchanged, 2 added | 21 unchanged | 2 unchanged |

Other changed sentences: the AEP Authority Chain divergence sentence and the AEP projection sentence on persistent versions; the MAR OpenShell materializer bullet; the DSC projection bullet. Every changed sentence is in an implementation projection or corrects a sentence that contradicts the same specification's version 4 envelope; no design rule changed.

## Issues Opened

- #486 `[catalog] Agent Plugin import merges a name-derived id collision into an existing entry and records no source provenance`, blocking candidate (retained data).
- #487 `[catalog] Agent Plugin management has only list and import, and authored setup does not expand an installation`, enhancement.
- #488 `[mcp] Plugin MCP import treats SSE as Streamable HTTP, skips the format version, and does not contain an explicit stdio cwd`, ordinary.
- #489 `[mcp] Workspace MCP management has no stage-version or remove, and selection names no expected current digest`, ordinary.
- #490 `[mcp] Plugin MCP package data key derives from the entry id, so installations do not get their own key`, ordinary.
- #491 `[aep] Build egress host accepts URL, path, and port forms at package resolution`, ordinary (raised from low by a comment).
- #492 `[catalog] Skill directory walk rejects a directory at depth 32 although 32 levels are allowed`, low.
- Existing #394 defines catalog distribution and update trust and does not cover these defects.

## Questions For The Engineer

### Q-113. Which readiness vocabulary is product-visible?

- Context: Core Agent Supply keeps five internal states and projects only a summary; MAR calls readiness product-visible with `ready`, `degraded`, `blocked`, and `stale` target states; the code has the five Core values.
- Options: (A) MAR states the Core internal vocabulary and moves `stale` to the protocol-owned summary as a target. (B) Amend Core.
- Recommendation: A. Core owns the split.
- Meanwhile: no change.

### Q-114. Should the direct-Provider route arms stay in the package schema?

- Context: AEP version 4 has one accepted inference shape, and direct Provider authority fails before launch; the schema still admits `direct-external` and `direct-provider`, which the always-required trusted relay rejects.
- Options: (A) Remove the arms. (B) Keep them and state why.
- Recommendation: A, under NONNEG-001.
- Meanwhile: no change.

### Q-115. What do the stale Provider references in MAR mean?

- Context: MAR Materialization lists "provider endpoint config", while workers receive only the Gateway binding; MAR line 305 lists the forbidden `providers` section among authority-bearing sections.
- Options: (A) Change the bullet to the Gateway inference endpoint binding and remove `providers` from the list. (B) Keep both.
- Recommendation: A.
- Meanwhile: no change.

### Q-116. Withdrawn

- The independent review showed that SKL decides the `.git` case and that the depth bound is a code defect (issue #492). No question remains.

### Q-117. Is the conflict diagnostic the `conflict` outcome, and is the expected digest mandatory?

- Context: SKL requires `conflict` for conflicting exact references; the resolver emits the blocking error `agent_setup.conflicting_skill_versions`. SKL requires promotion and rollback to name the expected current digest; the core function checks it only when present.
- Options: (A) State that the setup diagnostic is the `conflict` outcome, and make the field mandatory at the public boundary. (B) Rename the code.
- Recommendation: A.
- Meanwhile: no change.

### Q-118. Withdrawn

- The independent review showed that PLG and MCC decide narrow-boundary admission, so the whole-package refusal is a code defect, now part of issue #487. No question remains.

### Q-119. Must a Git data source use HTTPS?

- Context: DSC requires a network-addressable URL and commit pin; the code accepts only `https:` with exactly `url` and `commit`.
- Options: (A) State HTTPS and the closed key set in DSC. (B) Admit other schemes.
- Recommendation: A, for the first-release token model.
- Meanwhile: no change.

### Q-120. When must capability rows carry a source id?

- Context: DSC requires source-id lineage on capability and usage rows that touch a source; the ledger stores `sourceIds`, but no producer touches a catalog source today, and the Git root touches only the Sandbox.
- Options: (A) State that the requirement applies to future source-aware producers. (B) Keep the MUST and track a producer.
- Recommendation: A.
- Meanwhile: no change.

### Q-121. How should the agent-supply history, status, numbers, and time-relative text be fixed?

- Context: the G5 items above.
- Options: (A) As Q-28: remove history and status sentences or move them to change records, mark experience-chosen numbers as current defaults, and replace time-relative text. (B) Keep them.
- Recommendation: A.
- Meanwhile: no change.

## Independent Review

A fresh Reviewer context received the diff, this record, and the inventory, and checked the cited code and issues #486 to #491 itself. Verdict: changes requested. Dispositions:

1. The AEP projection edit still said verified native resource materialization is not implemented, but the Worker Shim verifies each installed Skill tree digest. Accepted; the sentence names that check and limits the gap to MCP and Plugin resources.
2. Q-118 was not open: PLG and MCC decide narrow-boundary admission. Accepted; the row is now an issue finding on #487 with a comment, and Q-118 is withdrawn.
3. Q-116 was not open: SKL decides `.git`, and the depth bound is a code defect. Accepted; issue #492 is opened, the `.git` row is a match, and Q-116 is withdrawn.
4. The egress row and #491 understated the defect, because a URL-form host also passes NanoHost. Accepted; the row is corrected and a comment on #491 raises the severity hint to ordinary.
5. The runtime-file citation pointed to the wrong lines. Accepted; it cites `turn-executor-factory.ts:6218-6227`.
6. The `sourceIds` citation pointed to the wrong line. Accepted; it cites `usage-ledger.ts:122,385`.
7. The PLG gap list omitted `select` and contradicted the re-import behavior. Accepted; the projection names `select`, says "update other than re-import", and adds the member-delta gap to the #486 clause.

The Reviewer confirmed the other edits, issues #486 to #490, the AS-MCC-01 false positive in the MCP SDK client (`listTools` without a cursor walks every page up to `listMaxPages`), the inventory table, and spot-checked Q-113, Q-115, Q-117, and Q-119. It found no content-safety or style problem.

## Checks

Run on the working tree before the commit:

- `node scripts/validate-doc-model.mjs`: "Validated documentation model (671 documents)."
- `node scripts/generate-doc-index.mjs`: "Wrote docs/INDEX.md."
- `pnpm check:repo`: exit status 0.
- Content scan of the staged diff (emails, tokens, local absolute paths, Vietnamese diacritics): no match.
