---
date: "2026-10-30"
---
# Independent Documentation Audit: Answers For Mediation

This non-authorizing record follows [Change Execution Governance](../change-execution.md). It records answers to the [mediation audit](20261024-independent_doc_audit_mediation.md), [supplement](20261025-independent_doc_audit_supplement.md) and the supplied Q-29 correction in the [audit index](20261023-independent_doc_audit.md). It does not authorize design or publication.

**Answered by coordinator and consultant consensus under the engineer's delegation of 2026-10-30**. The coordinator accepted all 31 answers and directed the two amendments recorded below.

## Scope

Reviewed the landed Part 5 main at `3a0910618aa8ba08955ebaf3451122358b6c6fff`. The code and packaged CLI paths cited in the independent answer review are unchanged from `32c1741a0a3f59c670d9d9e07be8252319cde7ca`; newly stated implementation facts were rechecked on the landed base. The Part 3 answer record supplied the record format, not the answers.

This batch changes 15 existing documents, this new record and the generated index. The coordinator explicitly assigned the MCP Catalog, Agent Environment Package, Policy Enforcement, Core term index and Internal Agent Resource Integration corrections to this batch. Agent Manifest remains with its other writer; held documents, existing audit records, AGENTS files and Product Vision remain unchanged. No code, retained format, registry, publication or product scope is added.

31 answers: 16 DOC, 13 CODE, 0 HELD, 2 NONE, 0 ESCALATE-E. CODE questions Q-89, Q-92 and Q-108 include the agreed owner clarifications; their implementation defects remain open. The forwarded Q-194 edits are recorded separately and do not add a question to this count.

## Answers

| Question | Answer | Fix type | Documents changed |
| --- | --- | --- | --- |
| Q-85 (D) | Core/Gateway owns rate-limit and quota semantics and enforcement hooks; Policy remains the permission authority, and the transport-only Capability Mediation Boundary owns neither. Generic rate/concurrency and token-budget gates are absent, additive after v0.1.0 and already tracked by [#282](https://github.com/lingkaix/openkit/issues/282)/[#283](https://github.com/lingkaix/openkit/issues/283); no new budget owner is needed. | NONE | None |
| Q-86 (D) | Keep the existing split: Core owns semantic Operation and point identity; OD owns declaration/projections; Policy Enforcement owns Policy bindings and decisions at those stages. Clarify OD without moving authority. | DOC | [OD] |
| Q-87 (D) | Boot self-check is permanently Kernel-only under the current contract; remove its planned participant-routing marker. | DOC | [ICP] |
| Q-88 (O) | Pending Requests and code already retain the failed execution call and refusal decision after claim, without contact or usage. Correct the remaining CUG exclusion and MCP/ICP ordering and acceptance statements. | DOC | [CUG], [MCP], [ICP] |
| Q-89 (D) | Keep schemaSnapshotId immutable. A permitted list-tools replay must supply the verified retained stamp; it must not conflict merely because first execution stamped the row, reopen the call, or recontact upstream. Follow-up: [#579](https://github.com/lingkaix/openkit/issues/579). | CODE | [CUG] |
| Q-90 (D) | Fail closed at shared admission for a Workspace-attributed llm/mcp call with no authority actor; producer checks alone do not protect admission Audit and usage attribution. Keep unattributed Server diagnostics separate. Follow-up: [#580](https://github.com/lingkaix/openkit/issues/580). | CODE | None |
| Q-91 (D) | A distinct authenticated repeat gets its own denied, no-contact CapabilityCall while returning the existing Pending Request. An exact protocol-request replay reuses its original call rather than creating a duplicate. Follow-up: [#581](https://github.com/lingkaix/openkit/issues/581). | CODE | None |
| Q-92 (D) | Use the current MCP owner vocabulary: real denials normalize to mcp-denied, unavailable decision evidence remains failure, and recovery_required remains uncertainty. Mark the unused WAC capability_* list as deferred; never expose which authority source denied the Tool. Follow-up: [#582](https://github.com/lingkaix/openkit/issues/582). | CODE | [MCP], [WAC] |
| Q-93 (D) | Revocation must close affected resident stdio sessions through the existing Gateway supervisor, not wait for another call or idle expiry. Closed #476 handles runtime credential bindings, not this Gateway-only gap. Follow-up: [#583](https://github.com/lingkaix/openkit/issues/583). | CODE | None |
| Q-94 (D) | Already explicit: discovery contact is not target-Tool contact and does not consume tool_calls. A proved uncontacted target Tool emits no usage even if credentialed discovery ran. | NONE | None |
| Q-95 (D) | Document the two actual exclusion codes and the conservative fixed annotations of multiplexed openkit_call. Exact per-operation mutation posture remains in openkit_describe. | DOC | [OD] |
| Q-96 (D) | Document all seven existing credential procedures and the already-declared sensitivity/framing facts. Gateway transport authentication is not an OperationCredential value. | DOC | [OD] |
| Q-97 (D) | Move Goal-specific coordinator validation behind its existing owned admission/resolver entry. Common schema-driven admission must not dispatch Goal behavior by entry kind or infer bound fields from a family schema. Follow-up: [#584](https://github.com/lingkaix/openkit/issues/584). | CODE | None |
| Q-98 (D) | State the existing JSON mutation rule once in OD: declared requestId is header-bound and contradictory body identity fails before effects. Do not require request IDs on reads that do not declare them. | DOC | [OD] |
| Q-99 (D) | No remaining hand-written JSON product operation was found; support and streaming bindings keep their owners. Remove the stale migration claims, retain Partial for concrete remaining work such as Q-97, and do not count conditional future data-defined sources as a current migration backlog. | DOC | [OD] |
| Q-100 (D) | State unconditional built-in supply, including automation.event-admit; presence grants no authority. Its existing live scheduled-poll checks already exclude ordinary or stale Workers, so selective supply is unnecessary. | DOC | [WAC] |
| Q-101 (D) | Artifact submission accepts syntactically valid media types; there is no product media-type allowlist to enforce. Correct the two misleading admission words, preserving separate owner validation. | DOC | [WAC] |
| Q-102 (D) | Remove unreachable advise/transform execution scaffolding while retaining their accepted vocabulary and fail-closed activation restriction. A future safe output owner can add execution without changing current authority. Follow-up: [#585](https://github.com/lingkaix/openkit/issues/585). | CODE | None |
| Q-103 (D) | PIA governs the NanoCore Gateway adapter; Worker-runtime dependencies are outside its pin. Retain the landed NanoCore 0.99.2 projection and the independent Pi host 1.0.2 dependency. | DOC | [PIA] |
| Q-104 (D) | Hash explicit and metadata cache-key hints under the normalized provider/model and full subscription-provider/account-slot scope before provider use. Preserve trusted lineage precedence; closed #484 fixed that separate precedence defect. Follow-up: [#586](https://github.com/lingkaix/openkit/issues/586). | CODE | None |
| Q-105 (D) | Ignore unknown additive model-metadata leaves with a diagnostic; continue rejecting malformed known fields and keys naming models outside the profile. This matches current parsing and COMPAT-001. | DOC | [GW] |
| Q-106 (D) | State read-time/post-error reconciliation instead of a nonexistent startup pass. Preserve strict persistence and Vault failure semantics; open #482 separately covers locked-Vault status projection. | DOC | [PSA] |
| Q-107 (D) | Remove the redundant server quota label only. Retain optional activeUntil: PSA already owns display of an available retained claim and Web consumes it; no new producer or entitlement meaning is authorized. Follow-up: [#587](https://github.com/lingkaix/openkit/issues/587). | CODE | None |
| Q-108 (D*) | Keep the settled narrow cleanup exception for residue proved to belong to the current empty create attempt. Pre-existing or uncertain residue, published metadata and live Vault material retain fail-closed recovery; implementation remains tracked below. Follow-up: [#588](https://github.com/lingkaix/openkit/issues/588). | CODE | [PSA] |
| Q-109 (D) | Read current validated account settings on inference admission without running the audit-bearing lifecycle reconcile. Preserve the existing pair fence, credential/version checks and quota decision. Follow-up: [#589](https://github.com/lingkaix/openkit/issues/589). | CODE | None |
| Q-110 (D) | Create must return the same owner slot-invalid code as other pair-addressed operations. Let the owner classify an invalid supplied slot; keep strict object and unrelated input validation unchanged. Follow-up: [#590](https://github.com/lingkaix/openkit/issues/590). | CODE | None |
| Q-111 (D) | Split the long OD projection paragraph at topic boundaries after Q-99. Leave label and experience-number sweeps to Q-28/Q-23, except the I36 cell directly changed for Q-87. | DOC | [OD] |
| Q-112 (D) | The audit premise is stale: the packaged CLI explicitly excludes both Knowledge package streams because it has no file input/sink; current transport is the authenticated streaming App API. Correct Guide's incomplete stream-exclusion claim; CLI file handling and Web ([#384](https://github.com/lingkaix/openkit/issues/384)) are purely additive after-v0.1.0 work, not a mandate for a new channel. Follow-up: [#591](https://github.com/lingkaix/openkit/issues/591). | CODE | None |
| Q-195 (D*) | Keep one current Policy decision per effect, enabled built-in routes and exact credential restrictions. Reconcile catalog conditions, authentication/listener descriptions and existing Server accounting; preserve the held retention link; the coordinator applied the MAR sentence at landing. | DOC | [MCP], [GW], [CUG], [PIU], [MCC], [AEP], [MAR], [POL] |
| Q-196 (D) | Close the existing retained vocabularies in their owners and distinguish route categories and illustrative verbs. Correct the Pending derivation, Tool name and touch counter; leave the conditional Item wording unchanged because exhaustive producer evidence was not established. | DOC | [CUG], [WAC], [MCP], [M], [CRI], [IARI] |
| Q-29 (given) | Apply the supplied knowledge-injection Item terminology at all three agreed locations. | DOC | [M], [WAC] |

## Verified Facts And Criterion Locations

Code citations refer to the landed review base. Each criterion was edited in its existing owner and section. Q-111 only splits the OD implementation projection by topic; no contract moves to this record. Unrelated numeric, label and digest sweeps remain with Q-23, Q-28 and Q-189.

| Questions | Existing and final owner locations | Evidence and limit |
| --- | --- | --- |
| Q-29 | [M], Relationship To Items; [WAC], Knowledge Gateway and Resolved Decisions | All three old context-injection Item terms were replaced with the supplied knowledge-injection terms. No record shape changes. |
| Q-85, Q-86, Q-87 | [M], Boundary and Enforcement Points; [OD], Mediation Registry Extension; [ICP], I36 | Core owns the semantic Operation and point identity; OD owns declaration and projections; Policy owns its bindings and decisions. Core boot admission accepts no participants; I36 now states that exclusion. The generic limiter and budget gates remain additive under #282/#283. |
| Q-88 | [CUG], GatewayCallContext; [MCP], Accepted Design and Acceptance; [ICP], Native Reset Slice | `apps/nanocore/src/runtime/captured-pending-call.ts:162,175,196,212` retains post-claim admission and failed finish. [PR] owns refusal and no-contact semantics; its landed text is not changed. |
| Q-89 | [CUG], CapabilityCall lifecycle | `apps/nanocore/src/capability/usage-ledger.ts:1551` compares schemaSnapshotId as immutable attribution. The producer correction remains #579. |
| Q-92, Q-95 | [MCP], Error normalization; [WAC], Error Model; [OD], Remote MCP Projection | `apps/nanocore/src/remote-mcp-routes.ts:154,245` supplies all four conservative annotations and both exclusion codes. `apps/nanocore/src/worker-mcp-routes.ts:1738,1858,1988` still needs #582 normalization; this documentation change does not claim that fix. |
| Q-96, Q-98 | [OD], Declarative Definition and Other Projections | `packages/app-api-schemas/src/operation-contract.ts:5,105,110,150` declares seven credential procedures and the sensitivity, mutation-target and framing facts. `apps/nanocore/src/operation-json-routes.ts:66,73` binds mutating requestId to the header and refuses contradictions. |
| Q-99, Q-111 | [OD], Current Implementation Projection | `apps/nanocore/src/app.ts:2581` registers the definition-derived JSON binding. `apps/nanocore/src/operation-json-routes.ts:22` projects the JSON definitions. `apps/nanocore/src/operation-resolvers.ts:289,299` still contains the Goal checks tracked by #584; Partial remains truthful. |
| Q-100, Q-101 | [WAC], Built-In Work Target | `apps/nanocore/src/runtime/openkit-work-supply.ts:130,203` supplies automation and Knowledge Tools unconditionally. `apps/nanocore/src/runtime/external-trigger-service.ts:164` checks live poll lineage and authority. `packages/protocol/src/models/artifact.ts:27` validates media-type syntax without a product allowlist. |
| Q-103, Q-105 | [PIA], Current Implementation Projection; [GW], Provider model metadata | `packages/pi-runtime-host/package.json:18` pins its separate runtime dependency. `packages/config-schema/src/provider.ts:90,98,105,112` strips additive metadata fields; `apps/nanocore/src/config/runtime-config-files.ts:796` emits diagnostics. |
| Q-106, Q-108 | [PSA], Account Lifecycle and Failure And Recovery Semantics | `apps/nanocore/src/llm/provider-subscription-accounts.ts:1192,1197` reconciles at status read. Its `writeAccount` at line 2188 still lacks the narrowly authorized create cleanup; #588 owns that implementation. No general cleanup path or residue exemption was added. |
| Q-107 | [PSA], Codex quota; no field-removal change here | `apps/nanocore/src/llm/codex-quota.ts:493` generates redundant labels. `packages/app-api-schemas/src/provider-subscriptions.ts:269` and `apps/web/src/screens/settings/data.ts:604` retain and consume optional activeUntil. #587 removes only the unused label. |
| Q-112 | Knowledge package owner and remote MCP Guide; no transfer change here | `skills/openkit-operations.mjs:464,468,475` explicitly excludes CLI package file transfer. `apps/nanocore/src/remote-mcp-routes.ts:37,47` needs the Guide correction in #591. Native streaming App API remains the current channel; additional channels remain additive. |
| Q-195 | [MCP], Policy binding; [MCC], Workspace binding; [AEP], capability projection | `apps/nanocore/src/runtime/agent-environment.ts:490,697` always includes built-ins and enables the three governed routes. Selected allowedTools remains supply; prohibitions and approval conditions remain Policy-owned. No blanket grant was added. |
| Q-195 | [GW], listeners and authentication; [POL], llm.gateway.use mapping | `apps/nanocore/src/app.ts:1975`, `apps/nanocore/src/index.ts:706` and `Caddyfile:45` distinguish the NanoCore listener from the public Web origin. `apps/nanocore/src/auth/middleware.ts:122,141,168` preserves local loopback and presented-credential checks. `apps/nanocore/src/auth/operation-access.ts:112` marks inference mutating; `apps/nanocore/src/policy/workspace-access.ts:168` prevents a Workspace token from gaining unscoped User authority. |
| Q-195 | [GW], route lineage; [CUG], context, idempotency and storage; [PIU], attribution | `apps/nanocore/src/llm/gateway-routes.ts:201,207,271` uses Core for authorized calls without Workspace lineage. `apps/nanocore/src/capability/usage-ledger.ts:1489,1504` looks up the tuple in its owning database with null Workspace identity for Server calls. The existing held-retention link is preserved; its target is not edited. |
| Q-196 | [CUG], context and lifecycle; [WAC], categories and Request Envelope; [MCP], protocol binding | `apps/nanocore/src/storage/schema/capability-usage-ledger.ts:26` declares the seven retained families. `apps/nanocore/src/capability/usage-ledger.ts:596,983` records failed/usage_record_failed and unknown/capability_call_recovered_after_restart. `apps/nanocore/src/runtime/pending-requests.ts:574` owns the distinct pending-call derivation. Future route categories and envelope wording do not redefine these retained identities. |
| Q-196 | [M], Internal Role Tool Identity; [CRI], term index; [IARI], Tool identity and counter | [OD] names administration.configuration.dispatch as the Tool. `apps/nanocore/src/internal-agents/internal-agent-loop.ts:270,276,286` excludes missing Tools and invalid arguments but counts an invoked closure, including refusal. The undefined AgentCapability index term is removed; the verb examples do not claim to enumerate every accepted operation ID. |

### Conditional Item Amendment

The coordinator required evidence for every current product-visible CapabilityCall producer before strengthening the Principles sentence in [M]. That universal coverage was not established. The shared context permits a null Item at `apps/nanocore/src/capability/usage-ledger.ts:107`; public Gateway admission can retain null at `apps/nanocore/src/llm/gateway-routes.ts:243`; captured approval admission uses null before downstream publication at `apps/nanocore/src/runtime/captured-pending-call.ts:190`. These facts alone neither prove nor disprove later Item linkage for every product-visible producer.

The sentence “Capability calls that are product-visible should remain item-backed; infrastructure calls may stay in capability, usage, and audit records.” is therefore unchanged. The existing MUST in Relationship To Items remains unchanged except for the supplied Q-29 Item name. This record claims no exhaustive implementation proof.

## Code Issues

The coordinator filed these issues with the bug and doc-audit labels. This batch edits documentation only and does not close them.

| Question | Filed issue | Remaining implementation correction |
| --- | --- | --- |
| Q-89 | [#579](https://github.com/lingkaix/openkit/issues/579) | Preserve the retained snapshot on exact list-tools replay without a new upstream call. |
| Q-90 | [#580](https://github.com/lingkaix/openkit/issues/580) | Refuse null authority actors at shared Workspace LLM/MCP admission. |
| Q-91 | [#581](https://github.com/lingkaix/openkit/issues/581) | Record each distinct pending-call repeat while retaining the original approval. |
| Q-92 | [#582](https://github.com/lingkaix/openkit/issues/582) | Normalize worker errors without exposing the authority source or converting uncertainty into denial. |
| Q-93 | [#583](https://github.com/lingkaix/openkit/issues/583) | Connect credential revocation to affected resident Gateway stdio teardown. |
| Q-97 | [#584](https://github.com/lingkaix/openkit/issues/584) | Move Goal-specific checks behind their owned resolver entry. |
| Q-102 | [#585](https://github.com/lingkaix/openkit/issues/585) | Remove inactive advise/transform execution scaffolding while retaining activation refusal. |
| Q-104 | [#586](https://github.com/lingkaix/openkit/issues/586) | Hash explicit cache hints within the provider and full subscription-account scope. |
| Q-107 | [#587](https://github.com/lingkaix/openkit/issues/587) | Remove only the redundant quota label; retain optional activeUntil. |
| Q-108 | [#588](https://github.com/lingkaix/openkit/issues/588) | Clean only proved residue from the current empty create attempt. |
| Q-109 | [#589](https://github.com/lingkaix/openkit/issues/589) | Avoid audit-bearing account reconciliation on every inference admission. |
| Q-110 | [#590](https://github.com/lingkaix/openkit/issues/590) | Return the owner slot-invalid error on create. |
| Q-112 | [#591](https://github.com/lingkaix/openkit/issues/591) | Correct Guide stream exclusions without claiming an absent CLI transfer channel. |

## Forwarded Q-194 Facts

The vault and agent-supply batch owns the Q-194 answer. The coordinator forwarded three [PSA] corrections to this writer: name the twelve account-sensitive operations, remove the stale nine-operation acceptance count, and separate quota window identifiers from duration labels.

`packages/app-api-schemas/src/provider-subscription-operations.ts:25,38,77,90,181` declares thirteen operations, including Codex settings and reset consumption. Only provider inventory is account-state-free: `apps/nanocore/src/llm/provider-subscription-operation-implementations.ts:89` returns the static inventory, while the account paths use the manager. `apps/nanocore/src/llm/codex-quota.ts:378,379,492` preserves primary/secondary identity independently of reported duration. The three text replacements retain the original persistence, admission and failure criteria.

## Cross-Part Disposition

The coordinator reassigned and this batch applied the agreed [MCC], [AEP], [POL], [CRI] and [IARI] corrections. The coordinator applied this exact [MAR] sentence replacement at landing, after the vault and agent-supply batch landed:

- Old: “packages without selected MCP supply keep the plane disabled.”
- New: “packages without selected external MCP supply retain the same three governed routes for built-in supply, subject to current call authority.”

## Held Fixes And Escalations

No HELD or ESCALATE-E answer is introduced. No document held by #440 was edited. The retained link from [GW] continues to the held retention owner without changing that owner. Generic rate/concurrency and token-budget gates remain with [#282](https://github.com/lingkaix/openkit/issues/282) and [#283](https://github.com/lingkaix/openkit/issues/283); additional Knowledge transfer surfaces remain additive, including Web under [#384](https://github.com/lingkaix/openkit/issues/384).

## Verification

- Source inspection confirmed the facts and code citations above on the landed Part 5 base.
- `pnpm install --frozen-lockfile --ignore-scripts`: passed without a lockfile change.
- `node scripts/generate-doc-index.mjs`: passed; the generated index includes this record.
- `pnpm -s check:repo`, through the coordinator's required slot wrapper: passed. Biome reported 69 warnings and 19 informational diagnostics in unchanged code; no fixes were applied.
- Final whitespace and commit safety scan results are reported with the local commit.

[M]: ../core/mediation.md
[OD]: ../specs/20261002-operation_definition.md
[WAC]: ../specs/20260703-worker_agent_capability.md
[CUG]: ../specs/20260704-capability_usage_gateway_foundation.md
[MCP]: ../specs/20260704-worker_mcp_tool_supply.md
[GW]: ../specs/20260526-llm_gateway_responses_api.md
[PIA]: ../specs/20260703-pi_ai_provider_gateway_adoption.md
[PIU]: ../specs/20260708-pi_ai_unified_llm_backend.md
[PSA]: ../specs/20260721-provider_subscription_accounts.md
[ICP]: ../specs/20261018-nanocore_interception_and_information_consolidation.md
[PR]: ../specs/20260930-pending_requests.md
[POL]: ../specs/20260703-policy_enforcement_mapping.md
[AEP]: ../specs/20260616-agent_environment_package.md
[MAR]: ../specs/20260703-agent_manifest_aep_resolution.md
[MCC]: ../specs/20260907-mcp_catalog_management.md
[IARI]: ../specs/20260909-internal_agent_resource_integration.md
[CRI]: ../core/README.md
[KPKG]: ../specs/20261018-file_storage_and_knowledge_packages.md
