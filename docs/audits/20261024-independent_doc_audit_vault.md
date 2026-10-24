---
date: "2026-10-24"
---
# Independent Documentation Audit: Vault Group

This non-authorizing record holds the vault group of the [independent documentation audit](20261023-independent_doc_audit.md). Its owning rule is [Change Execution Governance](../change-execution.md). It records observations, dispositions, and questions. It does not authorize design.

## Scope And Base

- Group base SHA: `314f72fe2e62864b34eb30a155488c4507b80553` (`main` on 2026-10-24). Issue #440 had no comments and held no group in this scope.
- Core document: `docs/core/vault.md`.
- Specifications: `20260703-vault_secret_injection.md` (SI), `20260704-vault_backend_implementation.md` (VB), `20260709-worker_credential_access_declarations.md` (CAD), and `20260703-openshell_mechanism_internalization.md` (OMI).
- G3 inspection: two read-only inspector contexts (VA-SI for SI and CAD; VA-VB for VB and OMI). They read code only and ran no tests. The auditor verified each kept finding against the code.

## G2 Core Against Specifications

- VA-G2-01: Core Vault says that runtime material cannot be recalled, so the owning runtime lifecycle must stop or recycle the affected environment after revocation. SI and OMI state termination as a MUST, CAD requires that revocation interrupt the binding at once, SI also lists the same behavior under Deferred / Future Work, and VB says already injected material "follows the existing stale-receipt/session lifecycle". The specifications do not agree on whether the behavior is current. Question Q-81; the code gap is issue #476.
- VA-G2-02: Core Vault line 93 names the current encrypted-file backend, while its scope line excludes concrete backend implementation. Question Q-82.
- VA-G2-03: Core Vault requires that imported-history grants do not authorize; SI adds the `issuance=target` field rule. Core is silent on the field, so this is not a conflict.

## G3 Specifications Against Implementation

| Finding | Clause | Evidence (at the group base SHA) | Adjudication | Action |
| --- | --- | --- | --- | --- |
| VA-SI-01 | SI Grant Shape: Workspace-attributed use applies the current-authority predicate with `vault.use` before material leaves the backend | `apps/nanocore/src/worker-mcp-routes.ts:2732-2757,2847-2903` check grant shape only; the Workspace gate (`:3221-3240`) evaluates `tool.use`; `packages/config-schema/src/product-policy.ts:23,26` maps the two to different rights | Code differs from a current accepted document | Issue #474 (blocking candidate: credentials) |
| VA-CAD-01, 04 | CAD: failures happen before Vault resolution; unsupported backend visibility fails closed; no partial resolution | `apps/nanocore/src/runtime/agent-environment.ts:1302-1422` plans and resolves per declaration; refusals come later in `apps/nanocore/src/runtime/turn-executor-factory.ts:2991-2993,6181-6189` | Code differs from a current accepted document | Issue #475 (blocking candidate: credentials), with a comment that the metadata-only pass (`agent-environment.ts:264-273`) checks grant shape and `vault.use` for every declaration first |
| VA-CAD-03, VA-SI-04, VA-VB-05 | CAD: revocation interrupts and closes the binding at once; SI and OMI: revocation terminates the affected sandbox | Revocation callers only update rows and receipt projections (`apps/nanocore/src/vault/vault-receipt-revocation.ts`); no runtime consumer of `stale-session` | Code differs from current accepted documents; the specifications also disagree on the status | Issue #476 (blocking candidate: credentials); Question Q-81 |
| VA-CAD-02 | CAD Failure Semantics: stable non-secret error codes | `apps/nanocore/src/runtime/agent-environment.ts:1478-1555` throws free text | Code differs from a current accepted document | Issue #477 |
| VA-SI-02 | SI Grant Shape: require `issuance=target` | `apps/nanocore/src/administration/mcp-discovery-preview.ts:117-123` tests an id prefix | Code differs from a current accepted document | Issue #478 (low) |
| VA-VB-01, VA-SI-05 | VB: every successful `resolve` emits a `VaultUse` row | `apps/nanocore/src/runtime/turn-executor-factory.ts:4386-4398` resolves on the raw backend after restart | Code differs from current accepted documents; the Workspace synchronization owner requires the re-resolution but does not exempt it | Issue #479 |
| VA-SI-08, VA-CAD-06 | SI and CAD projections: runtime-file credentials materialize through NanoHost; CAD summary "proves runtime-file upload" | `apps/nanocore/src/runtime/turn-executor-factory.ts:6181-6189` throws for any runtime-file credential on persistent Worker images; CAD line 353 already says so | Projection drift; the missing capability itself differs from CAD Runtime File Visibility (line 223), which requires a backend-private temporary-file upload | Corrected in SI (two bullets) and in the CAD summary; the capability gap is issue #480. The same drift in `20260703-agent_manifest_aep_resolution.md:486` and `20260703-worker_agent_capability.md:114,378` is handed to the agent-supply and mediation groups |
| VA-SI-08 (table) | SI projection: `vault_grants` field list | `apps/nanocore/src/storage/schema/vault-grants.ts:35` has the required `issuance` column | Projection drift | `issuance` added |
| VA-CAD-05 | CAD projection: the Gateway accepts `mcp`, `mcp.list-tools`, or `mcp.call-tool` targets | `apps/nanocore/src/worker-mcp-routes.ts:2895` compares the target with the exact operation; the issuer schema allows only the two operation ids (`packages/app-api-schemas/src/vault-admin.ts:212`), and VB line 100 says the `mcp` family wildcard is not an exact target | Projection drift; the result fails closed | Bare `mcp` removed |
| VA-OMI-01 | OMI projection: the resolver writes a non-conforming receipt before the Provider rejection; runtime-file remains materializable | `apps/nanocore/src/runtime/worker-governance-turn-executor.ts:2072,2545-2550` buffers receipts and writes them after the submission is accepted | Projection drift | Corrected |
| VA-SI-03, VA-VB-04 | SI and VB: cross-scope use is explicit and needs grant and audit context | `apps/nanocore/src/vault/vault-use-audited-backend.ts:159-179` accepts any `grantId` string without loading it, and decrypts the whole store through `listReferences` for each check | No record decides the wrapper's role; the current callers validate the grant | Questions Q-73 and Q-74 |
| VA-SI-06 | SI Provider Credentials: the gateway validates the grant and records a receipt | `apps/nanocore/src/providers/vault-credential-resolver.ts:52-62` resolves server-owned provider references with `VaultUse` and no grant, as SI lines 186 and 347 describe | Inside-document conflict | Question Q-75 |
| VA-SI-07 | SI Resolved Decisions: worker-visible material requires an explicit policy decision | `apps/nanocore/src/vault/vault-operation-implementations.ts:380-394` and `apps/nanocore/src/administration/server-mcp-operations.ts:473-485` create grants with null decision and approval lineage | No record decides whether deployment-administrator authority is the decision | Question Q-76 |
| VA-VB-02 | VB: after grace, the backend destroys expired material | `apps/nanocore/src/vault/vault-encrypted-file-backend.ts:166-173` destroys an expired version only when it is resolved | Trigger not decided | Question Q-77 |
| VA-VB-03 | VB: revoke destroys all attributable material, including writer temporaries | `apps/nanocore/src/vault/vault-encrypted-file-store.ts:638-681` names the temporary by PID only and keeps it on failure; a same-PID restart gets `EEXIST` on every later write, including the revoke tombstone | The kept temporary is an intentional fail-closed choice; its effect on revocation is not decided | Question Q-78 (high priority) |
| VA-VB-06 | VB: the sole master-key source is the configured key file | `apps/nanocore/src/vault/vault-operation-implementations.ts:712-741` accepts a key in the unlock request, and an empty store is initialized from it (`vault-encrypted-file-store.ts:216-255`) | Not decided | Question Q-79 |
| VA-OMI-03 | OMI Drift Control: NanoHost rejects malformed intent | `apps/nanohost/src/openshell_policy.rs:129-290` lets a duplicate endpoint name replace an earlier one and renders the raw host | Not decided | Question Q-80 |
| VA other | SI line 260: the per-Turn Codex path reads new material at the next child | `apps/nanocore/src/runtime/worker-governance-turn-executor.ts:2545` delivers material once at `session.open`; CAD line 249 says session-static | Two accepted specifications disagree | Question Q-83 |
| VA matches | Reference and grant records and owner checks, issuance on import, plans and receipts, grant request flow, narrowing, AEP schema and resolver checks, key file loading, backend boundary and codes, store format, inventory strictness, admin operations, lock, export, typed OpenShell intent, default-deny egress, Provider attachment disabled | `apps/nanocore/src/vault/`, `apps/nanocore/src/runtime/agent-environment.ts`, `packages/config-schema/src/agent-environment.ts`, `apps/nanohost/src/openshell_policy.rs`, `apps/nanohost/src/main.rs:458` | Match | None |

Q-26 (architecture group) asked whether Vault screens may show an AgentSession id. The screens show it only as the optional grant target (`apps/web/src/screens/settings/VaultSecretsPanel.tsx:28,280,350`), which VB names; Q-26 stays open for the user-facing term.

## G4 Organization

No move, merge, or split is applied. VB and SI each keep a per-file implementation inventory in their projections; writing.md asks projections to name owners, not file layouts. That is recorded with Q-82 rather than rewritten, because the lists carry current-behavior claims.

## G5 Writing

- Undefined labels: "first slice" and "first-slice" (SI, CAD) and "existing V1 flows" (CAD). As Q-28: Question Q-84.
- History in accepted text: VB "the prior alternate-backend design" and "the prior Keychain backend source ... deleted". As Q-28: Question Q-84.
- CAD example `"vaultGrantId": "grant_foo_api"` is not a canonical grant id under `VaultGrantIdSchema`. Question Q-84.

## Semantic Preservation

| File | Normative sentences | Numbers | Backticked identifiers | Headings | Links |
| --- | --- | --- | --- | --- | --- |
| `20260703-vault_secret_injection.md` | 104 unchanged, 1 changed (runtime-file materialization) | 0 | 188 unchanged, 1 added | 30 unchanged | 4 unchanged |
| `20260709-worker_credential_access_declarations.md` | 72 unchanged, 2 changed (summary; Gateway targets) | 0 | 129 unchanged, 1 removed (`mcp`) | 38 unchanged | 2 unchanged |
| `20260703-openshell_mechanism_internalization.md` | 82 unchanged, 1 added (runtime-file rejection) | 0 | 181 unchanged, 1 added | 30 unchanged | 1 unchanged |

Other changed sentences: the SI OpenShell materialization bullet (runtime-env, runtime-file, and Codex auth JSON sentences) and the SI grant table field list; the OMI receipt sentence. Every changed sentence is in an implementation projection or a summary of current proof; no design rule changed. The removed `mcp` target described a value that the issuer never creates and the Gateway refuses.

## Issues Opened

- #474 `[vault] Worker MCP Gateway releases Vault material after a tool.use check, without the vault.use current-authority predicate`, blocking candidate (credentials).
- #475 `[vault] Worker credential declarations resolve secret material before the backend visibility check and before later declarations are validated`, blocking candidate (credentials).
- #476 `[vault] Credential revocation does not interrupt the resident binding or terminate the affected sandbox`, blocking candidate (credentials).
- #477 `[vault] Credential declaration failures use free text instead of the stable error codes`, ordinary.
- #478 `[vault] Administrator MCP discovery preview checks grant provenance by id prefix, not by the issuance field`, low.
- #479 `[vault] Restart re-resolution of collection runtime-env values reads the raw backend and writes no VaultUse`, ordinary.
- #480 `[vault] Persistent Worker images refuse every runtime-file credential, so runtime-file visibility cannot launch`, ordinary.
- Existing #352 tracks remaining audited Vault-use wiring after v0.1.0 and does not cover the restart path.

## Questions For The Engineer

### Q-73. Should the audited Vault wrapper validate the grant it is given?

- Context: the wrapper accepts a cross-scope reference whenever any `grantId` string is present and never loads the grant. Current callers validate the grant first and never need the exception.
- Options: (A) Remove the exception. (B) Load and validate the grant in the wrapper.
- Recommendation: A. The wrapper is the last gate before material leaves the backend, and no caller needs the exception.
- Meanwhile: no change.

### Q-74. Should an audited resolve read only the addressed reference?

- Context: each audited resolve calls `listReferences`, which authenticates and decrypts every entry of every reference, so one inconsistent reference makes every resolve fail.
- Options: (A) Read only the addressed reference's snapshot. (B) Keep the whole-store check and state it.
- Recommendation: A. VB scopes fail-closed to the addressed inventory.
- Meanwhile: no change.

### Q-75. Do server-owned provider credentials need a grant?

- Context: SI Provider Credentials says the gateway validates the grant and records a receipt; SI lines 186 and 347 and the code resolve server-owned provider references with `VaultUse` only.
- Options: (A) State the server-owned provider exception in Provider Credentials. (B) Require a grant and receipt.
- Recommendation: A. The material is never worker-visible.
- Meanwhile: no change.

### Q-76. Is deployment-administrator authority the policy decision for directly issued grants?

- Context: administrator grant creation, including worker-visible runtime-env grants, records no `PermissionDecision`; only the request flow records one.
- Options: (A) Record a `PermissionDecision` for worker-visible grants. (B) State that administrator authority is the decision.
- Recommendation: A, so every worker-visible grant has decision lineage.
- Meanwhile: no change.

### Q-77. When does the backend destroy an expired prior version?

- Context: the backend destroys an expired version only when someone resolves it, so a retired secret can stay decryptable on disk and in backups.
- Options: (A) Destroy at the next rotation or inventory pass after grace. (B) State lazy destruction.
- Recommendation: A. Rotation exists to retire a secret.
- Meanwhile: no change.

### Q-78. How does revoke proceed when a same-PID temporary file exists? (high priority)

- Context: a failed write keeps `.<name>.<pid>.tmp` to fail closed. After a restart with the same PID, which is normal for PID 1 in a container, every later write for that reference fails, including the revoke tombstone, until an operator removes the file.
- Options: (A) Add a random suffix to the temporary name and let revoke destroy any complete writer temporary. (B) Unlink the process's own temporary on failure. (C) Keep it and document the operator step.
- Recommendation: A. Revocation must not depend on manual cleanup.
- Meanwhile: no change.

### Q-79. May administrator unlock supply the master key and initialize an empty store?

- Context: VB names one configured key file; unlock also accepts a request key and initializes an empty store from it.
- Options: (A) Require the same raw key and allow initialization only from the key file. (B) State the request path as a second source.
- Recommendation: A.
- Meanwhile: no change.

### Q-80. Should NanoHost reject duplicate endpoint names and render the canonical host?

- Context: a duplicate name replaces the earlier policy entry without a diagnostic, and the rendered host is the raw string while the conflict check uses the canonical form.
- Options: (A) Reject duplicates and render the canonical host. (B) Keep it.
- Recommendation: A.
- Meanwhile: no change.

### Q-81. Is revocation-driven sandbox termination current or deferred?

- Context: SI, OMI, and CAD state it as a current MUST; SI Deferred / Future Work lists it; VB says injected material follows the stale-receipt lifecycle; OMI's projection says NanoHost terminates the affected sandbox. The code has no trigger (issue #476).
- Options: (A) Keep the MUST, state the gap in each projection, and remove the deferred bullet when #476 lands. (B) Move the behavior to deferred work in all owners.
- Recommendation: A.
- Meanwhile: no change.

### Q-82. Should Core Vault and the Vault projections drop file and backend inventories?

- Context: Core Vault names the encrypted-file backend although it excludes concrete backend implementation; SI and VB projections list files and tables.
- Options: (A) Move the backend sentence to VB and name owners instead of files. (B) Keep them.
- Recommendation: A.
- Meanwhile: no change.

### Q-83. Is runtime material per-Turn or session-static?

- Context: SI line 260 says the per-Turn Codex path reads new material at the next child; CAD line 249 says declared runtime-env credentials are session-static; the code delivers material once at `session.open`.
- Options: (A) Amend SI to the session-static rule. (B) Amend CAD.
- Recommendation: A.
- Meanwhile: no change.

### Q-84. How should the vault labels, history, and example ids be fixed?

- Context: "first slice", "existing V1 flows", the "prior" backend sentences, and the non-canonical `grant_foo_api` example.
- Options and recommendation: as Q-28, and use a canonical grant id in the example.
- Meanwhile: no change.

## Independent Review

A fresh Reviewer context received the diff, this record, and the inventory, and checked the cited code and issues itself. Verdict: changes requested. Dispositions:

1. The runtime-file rejection was recorded only as projection drift, but CAD line 223 requires the upload. Accepted; issue #480, and the G3 row points to it.
2. VA-CAD-05 cited the narrowing check instead of the issuer schema. Accepted; it now cites `packages/app-api-schemas/src/vault-admin.ts:212` and VB line 100.
3. Issue #475 did not mention the metadata-only pass. Accepted; a comment on #475 and the G3 row state it.
4. #474 was confirmed in the code.
5. The same runtime-file drift exists in two specifications of other groups. Accepted; they are handed to those groups in the G3 row.

The Reviewer confirmed the three specification edits, the kept criteria, the inventory counts, issues #476 to #479, spot-checked Q-73, Q-77, Q-78, and Q-83, and found no content-safety or style problem.

## Checks

Run on the working tree before the commit:

- `node scripts/validate-doc-model.mjs`: "Validated documentation model (669 documents)."
- `node scripts/generate-doc-index.mjs`: "Wrote docs/INDEX.md."
- `pnpm check:repo`: exit status 0.
- Content scan of the staged diff (emails, tokens, local absolute paths, Vietnamese diacritics): no match.
