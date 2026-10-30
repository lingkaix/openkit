---
date: "2026-10-30"
---
# Independent Documentation Audit: Answers For Vault And Agent Supply

This non-authorizing record follows [Change Execution Governance](../change-execution.md) and records answers to the [independent audit](20261023-independent_doc_audit.md) and [supplement](20261025-independent_doc_audit_supplement.md). It does not authorize design or publication.

**Answered by coordinator and consultant consensus under the engineer's delegation of 2026-10-30**. The coordinator accepted the documentation corrections and directed the Q-83 identity amendment. Q-194's environment-reference policy remains escalated to the engineer.

## Scope

The independent answers reviewed main `32c1741a0a3f59c670d9d9e07be8252319cde7ca` and the incoming Part 5 text. The agreed corrections were applied to landed Part 5, main `3a0910618aa8ba08955ebaf3451122358b6c6fff`. Implementation evidence cited below is unchanged between those commits.

Only Vault and agent-supply documents, the authorized Q-83 identity correction, this record and the generated index are changed. The independent answers did not consult other answer files. The Part 3 answer record supplied this record's format after consensus. Held documents, mediation documents and existing audit records remain unchanged.

20 answers: 9 DOC, 7 CODE, 0 HELD, 3 NONE, 1 ESCALATE-E. Q-116 and Q-118 were withdrawn and are excluded. Q-79 verifies an existing consensus; Q-81 verifies the existing owner's settled answer.

## Answers

| Question | Answer | Fix type | Documents changed |
| --- | --- | --- | --- |
| Q-73 (D) | Remove the audited wrapper's grant-id bypass. Existing consumers retain canonical grant validation at their effect boundary, including shared Server MCP. | CODE | None; [#571](https://github.com/lingkaix/openkit/issues/571) |
| Q-74 (D) | Ordinary resolution must inspect only its addressed reference for scope and resolved-version evidence. Keep whole-store inventory for operations whose owner requires it. | CODE | None; [#572](https://github.com/lingkaix/openkit/issues/572) |
| Q-75 (D) | Authored Server-owned Provider resolution uses Server scope and `VaultUse`, without a Worker grant or injection receipt. Use shared Server MCP as the explicit cross-scope example. | DOC | [SI] |
| Q-76 (D) | The authorized administrator explicitly decides the exact direct grant, and Audit records that actor. Request/review issuance retains its required PermissionDecision and Approval lineage; every use retains current authority checks. | DOC | [SI] |
| Q-77 (D) | Preserve expired-material destruction on the next addressed rotation or inventory pass, as well as an expired-version resolve. Reuse validated reference traversal without adding a background scheduler. | CODE | None; [#573](https://github.com/lingkaix/openkit/issues/573) |
| Q-78 (D) | Use collision-resistant exclusive temporary names so same-PID residue cannot block revocation. Preserve authenticated cleanup of complete attributable residue and refusal of unverifiable residue. | CODE | None; [#574](https://github.com/lingkaix/openkit/issues/574) |
| Q-79 (D*) | One configured key file remains the only master-key initialization source. Administrator unlock must reload that file and accept no request-supplied key. | CODE | None; [#575](https://github.com/lingkaix/openkit/issues/575) |
| Q-80 (D) | Reject duplicate endpoint names before rendering and emit the canonical host used by conflict admission. Silent map replacement and raw-host rendering violate existing intent. | CODE | None; [#576](https://github.com/lingkaix/openkit/issues/576) |
| Q-81 (O) | Revocation already fences Core authority, awaits runtime closure and fails when cleanup is unproved. No downstream correction remains for this question. | NONE | None |
| Q-82 (D) | Remove concrete backend selection from Core while retaining its storage exclusion. Keep useful pointers in named implementation projections, as current writing guidance permits. | DOC | [CV] |
| Q-83 (D) | Runtime credential declarations are session-static. A changed declaration or value enters a later AEP and successor AgentSession that resumes the retained native conversation. | DOC | [SI], [NIC] |
| Q-84 (D) | Use a canonical grant UUIDv7 in the example and remove two backend-history statements. Retain current backend exclusions and defer unrelated label cleanup to Q-28. | DOC | [CAD], [VB] |
| Q-113 (D) | Use Core's five internal readiness states and retain the protocol-owned public summary. Existing AgentSession reuse and replacement rules own stale snapshots. | DOC | [MAR] |
| Q-114 (D) | Remove unsupported direct-external and direct-provider schema arms. The accepted package and resolver provide governed Gateway inference. | CODE | None; [#577](https://github.com/lingkaix/openkit/issues/577) |
| Q-115 (D) | Remove the forbidden `providers` section from manifest classification and the redundant provider-endpoint bullet. The adjacent Integration-binding bullet already covers inference endpoints. | DOC | [MAR] |
| Q-117 (D) | The existing blocking conflict diagnostic satisfies the required outcome. Public candidate and selection schemas already require `expectedCurrentDigest`, including explicit null. | NONE | None |
| Q-119 (D) | State the existing Git locator contract: exactly `url` and `commit`, credential-free HTTPS without query or fragment, and a full immutable Git object id. Other transports are absent additive capabilities. | DOC | [DSC] |
| Q-120 (D) | Keep source-id lineage conditional on actually touching a catalog source. Current producers do not; a later source-aware producer must satisfy the existing rule. | NONE | None |
| Q-121 (D) | Remove obsolete draft history, pending-publication claims, dated image results and the false manifest-only source claim. Preserve real-use acceptance requirements and leave unrelated number and label sweeps separate. | DOC | [SKL], [MAR], [DSC] |
| Q-194 (D) | User reference metadata already lives in Core; managed User Vault lifecycle is absent and additive under #578. The conflicting development-only `env:` policy and production lookup require an engineer decision. | ESCALATE-E | None |

## Code Issues

The coordinator filed these issues. No code was changed in this batch. Evidence line numbers refer to the reviewed main commits.

| Question and issue | Defect and correction | Evidence |
| --- | --- | --- |
| Q-73 — [#571](https://github.com/lingkaix/openkit/issues/571) | A nonempty grant-id string bypasses reference-scope validation. Require the wrapper scope to match the reference and preserve consumer-owned grant validation. | `apps/nanocore/src/vault/vault-use-audited-backend.ts:174`; owner [VB]. |
| Q-74 — [#572](https://github.com/lingkaix/openkit/issues/572) | Scope admission and version evidence scan unrelated references. Use the addressed-reference boundary while preserving its integrity checks and separately owned inventory checks. | `apps/nanocore/src/vault/vault-use-audited-backend.ts:161,282`; `apps/nanocore/src/vault/vault-encrypted-file-backend.ts:168,381`; owner [VB]. |
| Q-77 — [#573](https://github.com/lingkaix/openkit/issues/573) | Expired prior material survives rotation and inventory. After full reference validation, destroy it on those existing paths while preserving grace and retained version history. | `apps/nanocore/src/vault/vault-encrypted-file-backend.ts:175,247,381`; owner [VB]. |
| Q-78 — [#574](https://github.com/lingkaix/openkit/issues/574) | A deterministic temporary name can prevent the revoke tombstone. Use collision-resistant exclusive names and preserve exact attribution and safe cleanup of existing complete temporaries. | `apps/nanocore/src/vault/vault-encrypted-file-store.ts:639,653`; `apps/nanocore/src/vault/vault-encrypted-file-backend.ts:360`; owner [VB]. |
| Q-79 — [#575](https://github.com/lingkaix/openkit/issues/575) | Request key bytes can initialize an empty store. Reload the configured key file at unlock, remove request key input and align generated projections. | `packages/app-api-schemas/src/vault-admin.ts:33`; `apps/nanocore/src/vault/vault-operation-implementations.ts:790`; `apps/nanocore/src/vault/vault-unlock-state.ts:96`; `apps/nanocore/src/vault/vault-encrypted-file-store.ts:216`; owner [VB]. |
| Q-80 — [#576](https://github.com/lingkaix/openkit/issues/576) | Endpoint-map insertion overwrites duplicate names, and rendering uses a noncanonical host. Reject duplicate names before effects and render the admitted canonical host. | `apps/nanohost/src/openshell_policy.rs:118,255,276`; owner [OpenShell Mechanism Internalization](../specs/20260703-openshell_mechanism_internalization.md). |
| Q-114 — [#577](https://github.com/lingkaix/openkit/issues/577) | The AEP schema retains unsupported direct inference branches. Remove them and their unused projections while retaining the governed Gateway binding and refusal coverage. | `packages/config-schema/src/agent-environment.ts:985,1029,1040,1283`; `apps/nanocore/src/runtime/agent-environment.ts:448,456`; owners [MAR] and [Agent Environment Package](../specs/20260616-agent_environment_package.md). |

## Settled And Unchanged

Q-81 is implemented by `fa564ba52`, with [#476](https://github.com/lingkaix/openkit/issues/476) closed. [VB] requires proved runtime closure. `apps/nanocore/src/vault/vault-operation-implementations.ts:70,427` and `apps/nanocore/src/runtime/worker-governance-turn-executor.ts:1907` implement the closure boundary. The deferred text does not defer runtime revocation itself.

Q-117's conflict diagnostic is at `apps/nanocore/src/agents/setup-resolver.ts:220`. `packages/app-api-schemas/src/resource-catalog.ts:262,272` requires the public digest precondition, and `packages/app-api-schemas/src/catalog-operations.ts:253,285` uses those schemas. An optional internal helper parameter does not weaken that public contract.

Q-120's source-id requirement remains conditional in [DSC]. Current producers in `apps/nanocore/src/capability/usage-ledger.ts:123,388,700`, `apps/nanocore/src/worker-mcp-routes.ts:347,3443` and `apps/nanocore/src/llm/gateway-routes.ts:249,918` do not touch catalog sources. Adding a source-aware producer is additive after-v0.1.0 work.

## Held Fixes

None. No proposed correction belongs to a document held by [#440](https://github.com/lingkaix/openkit/issues/440).

## Cross-Part Corrections

Q-83's two identity corrections were applied to [NIC] under the coordinator's explicit authorization. They remove the obsolete per-Turn Codex-child claim and project the accepted successor-AgentSession behavior from [CAD]. They add no restart command, replacement Thread or mutable AEP.

The coordinator assigned Q-194's three subscription corrections to the mediation batch. They concern the twelve account-sensitive operations, the obsolete operation count and the distinction between stable window identifiers and duration labels. This batch changes none of that document.

## Escalated

Q-194 remains ESCALATE-E. [SI] calls explicit `env:` references development-only where separately allowed, while production lookup has no such gate. `apps/nanocore/src/providers/registry.ts:205` resolves the named environment entry, and `apps/nanocore/src/index.ts:555` composes that path. No accepted exception owner was found. Selecting an allowance or removing the restriction decides credential-source policy. The engineer has that decision; the existing sentence remains unchanged.

User-scoped VaultReference metadata already uses Core: `apps/nanocore/src/vault/vault-references.ts:59,63,143`. `apps/nanocore/src/storage/schema/vault-use-records.ts:6` admits Server and Workspace scopes only, and [VB] excludes managed User lifecycle. The coordinator filed the absent additive User lifecycle as after-v0.1.0 work in [#578](https://github.com/lingkaix/openkit/issues/578). This deferral removes no existing User metadata and adds no User database or VaultUse field.

[CV]: ../core/vault.md
[SI]: ../specs/20260703-vault_secret_injection.md
[VB]: ../specs/20260704-vault_backend_implementation.md
[CAD]: ../specs/20260709-worker_credential_access_declarations.md
[NIC]: ../specs/20260628-nanocore_config_identity_contract.md
[MAR]: ../specs/20260703-agent_manifest_aep_resolution.md
[DSC]: ../specs/20260704-workspace_data_source_catalog.md
[SKL]: ../specs/20260711-skill_catalog_versioning_pinning.md
