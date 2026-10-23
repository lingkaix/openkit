# Independent Documentation Audit: G1 Clean-Room Probe

This record holds the module-level findings of the clean-room probe in Phase 1 of the [independent documentation audit](20261023-independent_doc_audit.md). The engineer directed the audit, so [Change Execution](../change-execution.md) is its owning rule. The record is non-authorizing evidence. The summary record holds the top-down derivation and the cross-cutting themes.

## Method

The auditor exported the documents at the audit base with `git archive 67d3e5a68453b9efd76c3313768c01dd87ae8cdb docs AGENTS.md` into an empty directory outside the repository. Eight fresh read-only inspectors each received that directory and one module brief. Each inspector wrote an implementation plan for its module and listed every point where it had to guess or where documents contradict each other.

The isolation rested on instruction, not on a sandbox. The inspectors could technically reach the repository. Each one reported that it read only the export. The M4 inspector reported one process slip: it created one scratch file outside the export during quote checking, deleted it at once, and confirmed the deletion. It reported no read of code.

A probe finding is an observation of the documents as the probe read them. It is not yet an adjudicated defect. The auditor checked a sample of the quoted evidence against the documents and found every sampled quote exact: M2-G04, M2-G11, M2-G12, M8-G01, M8-G05, M8-G09, and M4-G39. A finding becomes a disposition only in the group record of its assigned group, which verifies it first. A finding assigned to a held group waits for the release of that group under #440.

The severity is the probe's hint. "High" marks an effect on retained data formats, security, authorization, credentials, data loss, or recovery.

## Modules

| Module | Scope | Findings | High |
| --- | --- | --- | --- |
| M1 | Work backbone, product protocol, App API projection | 30 | 16 |
| M2 | Storage, retained formats, durability | 40 | 22 |
| M3 | Identity, authentication, Policy, Vault | 45 | 20 |
| M4 | Mediation, gateways, operations, remote MCP | 39 | 14 |
| M5 | Worker execution runtime | 30 | 11 |
| M6 | Knowledge and personal Memory | 34 | 12 |
| M7 | Internal agents and work modes | 36 | 17 |
| M8 | Product surfaces, Generative Apps, channels, deployment | 42 | 12 |
| Total | | 296 | 124 |

## Findings By Module

Each table lists the finding, its type, the severity hint, and the group that owns the fix. The probe used four types. "Contradiction" means that two documents state incompatible rules. "Missing" means that no document states a fact that a rebuild needs. "Ambiguous" means that a statement allows more than one reading. "Needs-code" means that the probe could not continue without the implementation. Two M5 findings carry the probe's own severity value "medium-high". "Held" marks a group that #440 holds. "Cross-cutting" names a theme in the summary record. A finding with two groups lists both, and the first group handles it.

The probe reports were working material outside the repository and are not retained. The tables keep each finding in short form. The group record that handles a finding verifies it again and quotes its document evidence.

### M1: Work Backbone And Product Protocol

| ID | Type | Severity | Finding | Group |
| --- | --- | --- | --- | --- |
| M1-G01 | contradiction | high | Workspace, Thread, Turn, and Item authority: `storage.md` gives it to the control store, while the retained format register and the Thread visibility projection name files. | storage (held) |
| M1-G02 | needs-code | high | No field-level schemas exist for Workspace, Thread, Turn, the seventeen Item payloads, or Artifact records. | protocol |
| M1-G03 | missing | high | The Workspace, Thread, and Item status enums and the Workspace kind set are never enumerated. | protocol |
| M1-G04 | contradiction | high | `core-concepts.md` says Protocol owns TriggerSource values, but `protocol.md` gives prose only, and specifications use scattered values. | protocol |
| M1-G05 | missing | high | Per-family event payload schemas, including the `turn.completed` payload, are undefined. | protocol |
| M1-G06 | missing | high | The Core HTTP and SSE projection (cursor parameter, frames, streams) is not specified. | communication |
| M1-G07 | contradiction | high | `since=0` is "not expired" in the storage layout specification but must fail with `core.stream.cursor_expired` under `protocol.md`; the 100-event window is unclassified. | protocol; storage (held) |
| M1-G08 | contradiction | medium | Server-owned Threads have no Workspace anchor, but the event envelope and cursors require `workspaceId`. | protocol |
| M1-G09 | missing | high | No owner names the producers of Turn `cancelled` or the `stopReason` its terminal event carries. | protocol |
| M1-G10 | missing | high | The idempotency ledger's semantic-input hash, receipt homes, and command-name spelling are undefined. | protocol |
| M1-G11 | needs-code | high | The operation inventory and the field-to-HTTP placement exist only in code definition tables. | mediation |
| M1-G12 | contradiction | high | The Multi-User Workspace specification makes the first terminal `PermissionDecision` the Approval winner, while Pending Requests makes its record authoritative. | identity; protocol |
| M1-G13 | contradiction | high | The responsible-user derivation differs between Pending Requests and Multi-User Workspace. | identity; protocol |
| M1-G14 | missing | high | Request, part, and question identifiers have no registered prefix. | protocol |
| M1-G15 | needs-code | high | No SQLite schema exists for Pending Request, receipt, or registry tables. | storage (held) |
| M1-G16 | contradiction | high | Format markers and the envelope `ownerScope` field do not fit the register and the protocol `owner` field. | storage (held) |
| M1-G17 | missing | high | Thread update, archive, and delete operations, and the Thread revision field, are undefined. | core-concepts |
| M1-G18 | ambiguous | medium | The actor of a policy-granted approval conflicts with the rule that decisions require a user actor. | protocol |
| M1-G19 | missing | medium | The current `protocolVersion` value and its negotiation are not given. | protocol |
| M1-G20 | ambiguous | medium | Client tolerance of unknown fields and the `requestId` format conflict across owners. | protocol |
| M1-G21 | contradiction | medium | `protocol.md` requires namespaced error codes, but many specifications use bare codes. | protocol |
| M1-G22 | ambiguous | medium | The uniform denial result for an inaccessible Thread is unclear. | mediation |
| M1-G23 | missing | medium | `thread.share` confirmation, revision, and receipt details are undefined. | core-concepts |
| M1-G24 | missing | medium | The captured-call canonical form and delivery input shape are undefined. | protocol |
| M1-G25 | ambiguous | medium | The meaning of an `items.jsonl` row and the torn-tail rule conflict. | storage (held) |
| M1-G26 | contradiction | medium | `work-model.md` moves Quick Chat data one way, but the Quick Chat specification removes the conversion. | work-model (held) |
| M1-G27 | missing | medium | Item delta payload bounds and violation codes are unnamed. | protocol |
| M1-G28 | missing | medium | Artifact record fields and processor defaults are undefined. | work-model (held) |
| M1-G29 | missing | low | Channel pairing time-to-live, disclosure limit, and timestamp window are unnumbered. | protocol |
| M1-G30 | missing | low | The OpenAPI source digest has no canonicalization. | communication |

### M2: Storage, Retained Formats, And Durability

The probe concluded that a rebuild could not open and continue an existing data root from the documents alone. The storage group is held, so every M2 finding waits for its release.

| ID | Type | Severity | Finding |
| --- | --- | --- | --- |
| M2-G01 | contradiction | high | Existing data is file-first in the register and the layout specification, but SQL in `storage.md` and the Draft control-store specification. |
| M2-G02 | needs-code | high | No document owns SQLite DDL or the migration journals. |
| M2-G03 | needs-code | high | File-record field schemas are absent. |
| M2-G04 | contradiction | high | The Artifact version marker is `formatVersion: 1` in the layout specification and `schemaVersion 1` in the register. |
| M2-G05 | ambiguous | high | The representation of the SQL JSON marker is unclear. |
| M2-G06 | contradiction | high | The data-root trees of the layout and Multi-User specifications disagree and omit retained paths. |
| M2-G07 | ambiguous | high | Immutable content placement and staging names are unclear. |
| M2-G08 | ambiguous | high | The Item and event log line shape and the torn-tail rule conflict. |
| M2-G09 | contradiction | high | `restricted-raw` is "not a duration" in `storage.md` but has a bounded window in the audit specification; no window is assigned. |
| M2-G10 | missing | high | The `legal-hold` lifecycle has no operation or record. |
| M2-G11 | contradiction | high | The work-data specification defaults Capture Coverage to on and also says the capture defaults are still off. |
| M2-G12 | contradiction | high | The backup specification requires local hot backup before `v0.1.0` and also defers hot capture until after it. |
| M2-G13 | missing | high | The Workspace backup bundle format is unspecified. |
| M2-G14 | missing | high | The `moved-out` disposition does not fit the closed four-state registry. |
| M2-G15 | contradiction | high | V3 export must include three Knowledge ledgers that import must reject and the Knowledge specifications retire. |
| M2-G16 | contradiction | medium | The execution table names differ between the backup and control-store specifications. |
| M2-G17 | missing | high | The data-root backup format is unspecified. |
| M2-G18 | needs-code | medium | The full V3 export inventory is not given. |
| M2-G19 | ambiguous | high | The boot envelope verifier scope and the fresh-versus-missing test are unclear. |
| M2-G20 | missing | medium | The deployment identifier store and the layout marker fields are not given. |
| M2-G21 | needs-code | high | The execution-host retained volume format is unspecified. |
| M2-G22 | missing | medium | The Storage Service wire contract and its numbers are not given. |
| M2-G23 | ambiguous | high | The path of a captured Source original is unclear. |
| M2-G24 | missing | medium | `knowledgeMounts` and `defaultKnowledgeBaseId` are absent from the configuration contract. |
| M2-G25 | contradiction | high | Authored configuration authority is SQL heads in the Draft control store and file revisions in the configuration contract. |
| M2-G26 | missing | high | Work-observation type strings and payloads are not given. |
| M2-G27 | missing | medium | Thread segmentation field names are not given. |
| M2-G28 | ambiguous | medium | Contract numbers and current defaults are not distinguished. |
| M2-G29 | ambiguous | medium | The integrity check has no `cancelled` row. |
| M2-G30 | contradiction | medium | Exported bundles live in `server/files` and in `server/exports` in different statements. |
| M2-G31 | contradiction | medium | The tar path limit cannot carry a valid 240-byte Knowledge page identifier. |
| M2-G32 | missing | low | The `storage.layout-report` output is unspecified. |
| M2-G33 | ambiguous | medium | Which authored files carry `schemaVersion` is unclear. |
| M2-G34 | ambiguous | high | Restore across releases conflicts with retained data continuity. |
| M2-G35 | contradiction | medium | The home of recurring history differs between specifications. |
| M2-G36 | missing | medium | Worker volume export and restore have no format. |
| M2-G37 | missing | medium | Garbage-collection roots and backup retention are unspecified. |
| M2-G38 | ambiguous | low | Some registered feature identifiers break the stated naming rule. |
| M2-G39 | ambiguous | low | Pragmas for pre-existing databases are unstated. |
| M2-G40 | missing | medium | The Knowledge package tar details are unspecified. |

### M3: Identity, Authentication, Policy, And Vault

| ID | Type | Severity | Finding | Group |
| --- | --- | --- | --- | --- |
| M3-G01 | needs-code | high | Core SQLite DDL is not documented. | storage (held) |
| M3-G02 | missing | high | Encrypted-file Vault byte format. | vault |
| M3-G03 | missing | high | Token secret encoding and hash form. | identity |
| M3-G04 | missing | high | Better Auth surface and credential store. | identity |
| M3-G05 | missing | high | How non-owner Users come to exist. | identity |
| M3-G06 | missing | high | Policy statement grammar. | policy |
| M3-G07 | missing | high | Policy revision, digest and snapshot. | policy |
| M3-G08 | missing | high | Vault record vocabularies. | vault |
| M3-G09 | missing | high | Deletion `request.json` keys. | identity |
| M3-G10 | missing | high | `server.jsonc` schema, auth secret, mode selection. | identity |
| M3-G11 | missing | medium | Id prefixes. | protocol |
| M3-G12 | contradiction | medium | Data-root tree. | storage (held) |
| M3-G13 | contradiction | high | Fixed roles versus equal members. | identity |
| M3-G14 | ambiguous | high | Target versus running administrator behavior. | identity |
| M3-G15 | contradiction | medium | Session-derived admin: MUST versus MAY. | identity |
| M3-G16 | missing | high | Per-operation authorization map. | policy |
| M3-G17 | ambiguous | high | Which rights each association holds. | policy |
| M3-G18 | contradiction | high | TLS behind a proxy. | identity |
| M3-G19 | ambiguous | medium | Bearer verification in local mode. | identity |
| M3-G20 | missing | medium | Decision record shape and kernel ids. | policy |
| M3-G21 | contradiction | high | Local user id. | identity |
| M3-G22 | ambiguous | high | "Fresh initialization" test. | fault-tolerance (held) |
| M3-G23 | missing | high | Bootstrap ceremony details. | identity |
| M3-G24 | contradiction | medium | Recovery request identity. | identity |
| M3-G25 | missing | medium | Token operation inputs and defaults. | identity |
| M3-G26 | missing | medium | Audit action names. | evidence (held) |
| M3-G27 | ambiguous | medium | Email normalization. | identity |
| M3-G28 | contradiction | medium | Error-code naming and statuses. | protocol |
| M3-G29 | missing | medium | AuthSession lifecycle. | identity |
| M3-G30 | ambiguous | low | NanoHost token storage. | identity |
| M3-G31 | missing | medium | Vault numbers. | vault |
| M3-G32 | missing | medium | Admin Vault API. | vault |
| M3-G33 | contradiction | medium | Grant lifetimes and visibility. | vault |
| M3-G34 | ambiguous | medium | `sandbox-provider` default versus refusal. | vault |
| M3-G35 | missing | low | User-scope Vault and `env:` references. | vault |
| M3-G36 | missing | high | Stored subscription credential shape. | vault |
| M3-G37 | contradiction | medium | Provider-subscription counts and names. | vault |
| M3-G38 | ambiguous | low | Contract or default for numbers. | cross-cutting T5 |
| M3-G39 | ambiguous | medium | Which Policy features to build. | policy |
| M3-G40 | ambiguous | high | "Workspace administrator" is undefined. | policy |
| M3-G41 | missing | medium | Client credential store bytes. | identity |
| M3-G42 | ambiguous | medium | Desktop-embedded mode. | identity |
| M3-G43 | missing | medium | Abuse limits and counts. | identity |
| M3-G44 | missing | medium | Approval kind vocabulary. | policy |
| M3-G45 | ambiguous | low | `workspace-record.json` authority. | identity |

### M4: Mediation, Gateways, Operations, And Remote MCP

| ID | Type | Severity | Finding | Group |
| --- | --- | --- | --- | --- |
| M4-G01 | contradiction | high | CapabilityCall terminal status set. | mediation |
| M4-G02 | needs-code | high | CapabilityCall and UsageRecord stored shape. | mediation |
| M4-G03 | ambiguous | high | Statuses for crash recovery and ledger-write failure. | mediation |
| M4-G04 | contradiction | high | Capability family vocabulary (part of the idempotency key). | mediation |
| M4-G05 | missing | high | UsageRecord unit and source vocabularies. | mediation |
| M4-G06 | contradiction | high | Durable record for public Gateway calls without Workspace metadata. | mediation |
| M4-G07 | contradiction | high | Is the capability plane enabled for every package. | communication |
| M4-G08 | ambiguous | high | Which listener serves `/v1/*`; local-mode and credential rules. | mediation |
| M4-G09 | ambiguous | medium | Required `contextManagement` versus retained `gateway.jsonc`. | mediation |
| M4-G10 | missing | high | Provider profile file schema. | mediation |
| M4-G11 | missing | high | `gateway.jsonc` and `model-catalog.jsonc` key names. | mediation |
| M4-G12 | contradiction | high | MCP binding tool lists and default posture. | mediation |
| M4-G13 | missing | high | `catalog.json` shape and digest algorithms. | mediation |
| M4-G14 | ambiguous | high | Idempotency scope for Server-owned and null-request calls. | mediation |
| M4-G15 | needs-code | high | Operation catalog contents. | mediation |
| M4-G16 | ambiguous | medium | Derived CapabilityCall identity producers. | mediation |
| M4-G17 | contradiction | medium | Denial and error code families. | mediation |
| M4-G18 | missing | medium | Public Gateway error mapping and SSE termination. | mediation |
| M4-G19 | missing | medium | Gateway constants without values. | mediation |
| M4-G20 | missing | medium | `/v1/models` and `/health` payloads. | mediation |
| M4-G21 | contradiction | medium | Gateway enable flag and provider allowlist. | mediation |
| M4-G22 | contradiction | medium | Canonical ID spelling. | mediation |
| M4-G23 | contradiction | medium | Delegated configuration Tool and action names. | mediation |
| M4-G24 | contradiction | medium | Verb vocabulary versus released IDs. | mediation |
| M4-G25 | contradiction | medium | Per-Turn tool snapshot. | mediation |
| M4-G26 | missing | medium | MCP supervisor numbers. | mediation |
| M4-G27 | ambiguous | medium | Worker capability request envelope. | mediation |
| M4-G28 | missing | medium | Built-in worker Tool schemas. | mediation |
| M4-G29 | missing | medium | Remote MCP tool contracts. | mediation |
| M4-G30 | ambiguous | low | Remote MCP source summary and session posture. | mediation |
| M4-G31 | missing | medium | CLI payloads and labels. | topology |
| M4-G32 | missing | medium | Rate limits, budgets, load balancing. | mediation |
| M4-G33 | ambiguous | medium | Mediation pipeline scope and participant parameters. | mediation |
| M4-G34 | contradiction | medium | Item-backing of capability calls. | mediation |
| M4-G35 | ambiguous | medium | Provider families and external pi-ai / models.dev data. | mediation |
| M4-G36 | contradiction | medium | Capture default for gateway model I/O. | evidence (held) |
| M4-G37 | ambiguous | medium | Cutover-conditional contracts. | mediation |
| M4-G38 | missing | medium | Worker inference route details. | mediation |
| M4-G39 | missing | low | `AgentCapability` term. | mediation |

### M5: Worker Execution Runtime

| ID | Type | Severity | Finding | Group |
| --- | --- | --- | --- | --- |
| M5-G01 | contradiction | high | Retained record authority: files or SQLite. | storage (held) |
| M5-G02 | contradiction | high | Which scheduler to build. | runtime-model (held) |
| M5-G03 | needs-code | high | No SQL schemas. | storage (held) |
| M5-G04 | needs-code | high | AEP v4 and AgentManifest field schemas. | agent-supply |
| M5-G05 | needs-code | high | Per-Turn worker-control wire. | communication |
| M5-G06 | missing | high | NanoHost effect bodies and derivations. | runtime-model (held) |
| M5-G07 | missing | high | Execution-host retained layouts. | runtime-model (held) |
| M5-G08 | contradiction | high | Persistent mount targets. | sandbox |
| M5-G09 | contradiction | high | Main worktree path. | sandbox |
| M5-G10 | contradiction | high | Transcript and capture root. | sandbox |
| M5-G11 | missing | high | AgentSession record fields and status transitions. | agent-session |
| M5-G12 | contradiction | medium-high | Concurrent active Turns. | communication |
| M5-G13 | contradiction | medium | Harness operation count. | communication |
| M5-G14 | contradiction | medium | Capability plane enabled or disabled. | communication |
| M5-G15 | contradiction | medium | Which adapters exist and are enabled. | architecture |
| M5-G16 | contradiction | medium | Runtime pins. | architecture |
| M5-G17 | missing | medium-high | Probe-dependent adapter facts. | architecture |
| M5-G18 | missing | medium | Unnumbered limits. | runtime-model (held) |
| M5-G19 | ambiguous | medium | Contract or default. | cross-cutting T5 |
| M5-G20 | contradiction | medium | Header-timer rule. | communication |
| M5-G21 | contradiction | medium | Goal worker execution. | runtime-model (held) |
| M5-G22 | contradiction | medium | Number of Sandboxes and idle eviction. | runtime-model (held) |
| M5-G23 | ambiguous | medium | Compatibility key membership and digest. | agent-session |
| M5-G24 | needs-code | medium | OpenShell dependency. | sandbox |
| M5-G25 | ambiguous | medium | Compute neutrality. | architecture |
| M5-G26 | missing | medium | Operation I/O and error codes. | agent-supply |
| M5-G27 | missing | medium | Closed vocabularies. | runtime-model (held) |
| M5-G28 | missing | medium | Context Package `package.json`. | knowledge |
| M5-G29 | missing | medium | Configuration keys. | identity |
| M5-G30 | missing | low | Invalidation report format. | runtime-model (held) |

### M6: Knowledge And Personal Memory

| ID | Type | Severity | Finding | Group |
| --- | --- | --- | --- | --- |
| M6-G01 | contradiction | high | Where Sources live; recapture identity. | knowledge |
| M6-G02 | contradiction | high | What commits a publication: Git ref or SQL head. | knowledge |
| M6-G03 | missing | high | Default Scope Schema, schema-change flow, schema location. | knowledge |
| M6-G04 | missing | high | Front-matter value shapes and normalized fields. | knowledge |
| M6-G05 | missing | high | Daily maintenance switch. | identity |
| M6-G06 | contradiction/ambiguous | high | Who reads Server Knowledge; Worker ask scope. | mediation |
| M6-G07 | missing | high | Operation-to-right mapping; read-only posture. | policy |
| M6-G08 | contradiction/needs-code | medium | Operation IDs and schemas. | knowledge |
| M6-G09 | missing | high | Proposal and Review identity. | protocol |
| M6-G10 | missing | high | Git commit details. | knowledge |
| M6-G11 | missing | high | Forgetting and suppression. | knowledge |
| M6-G12 | contradiction | high | Workspace export V3 and retired ledgers. | storage (held) |
| M6-G13 | contradiction | high | Server maintenance has no Workspace; retrieval needs one. | protocol |
| M6-G14 | missing | medium | Ranking and tokenization parameters. | knowledge |
| M6-G15 | needs-code | medium | Kernel faces and bounds. | knowledge |
| M6-G16 | missing | medium | KM result schemas, Tools, citations. | knowledge |
| M6-G17 | ambiguous | medium | Maintenance input bounds. | knowledge |
| M6-G18 | missing | medium | Trace details. | knowledge |
| M6-G19 | contradiction | medium | Status disagreement on what must exist. | knowledge |
| M6-G20 | ambiguous | medium | Overview and package metadata. | knowledge |
| M6-G21 | missing | medium | Masking. | knowledge |
| M6-G22 | ambiguous | medium | Root index. | knowledge |
| M6-G23 | missing | medium | Knowledge Base and mount configuration. | identity |
| M6-G24 | missing | medium | Source capture fields. | knowledge |
| M6-G25 | missing | medium | Editing interpreter. | knowledge |
| M6-G26 | ambiguous | medium | Request identity, path form, list size. | knowledge |
| M6-G27 | missing | medium | Proposal lifecycle, retention, prune. | knowledge |
| M6-G28 | missing | medium | "Weak evidence" and lineage checks. | knowledge |
| M6-G29 | missing | medium | Maintenance Thread identity. | knowledge |
| M6-G30 | missing | medium | Memory and Server package routes. | knowledge |
| M6-G31 | contradiction | low | Item kind and acronym. | knowledge |
| M6-G32 | contradiction | low | Normative OKF snapshot. | knowledge |
| M6-G33 | ambiguous | low | Explicit state inspection. | knowledge |
| M6-G34 | ambiguous | low | Contract versus default for numbers. | cross-cutting T5 |

### M7: Internal Agents And Work Modes

| ID | Type | Severity | Finding | Group |
| --- | --- | --- | --- | --- |
| M7-G01 | missing | high | Goal, card and Plan retained formats. | work-model (held) |
| M7-G02 | missing | high | No prefix or generator for several retained ids. | work-model (held) |
| M7-G03 | missing | high | PendingRequest record and question shape. | work-model (held) |
| M7-G04 | contradiction | high | `context-summary` Item. | protocol |
| M7-G05 | missing | high | Turn record members. | work-model (held) |
| M7-G06 | contradiction | high | Recurring store and engine. | runtime-model (held) |
| M7-G07 | contradiction | high | Pre-reset Quick Chat data. | work-model (held) |
| M7-G08 | contradiction | high | Review selection storage. | work-model (held) |
| M7-G09 | missing | high | Evaluation Foundation interface and payload. | work-model (held) |
| M7-G10 | missing | high | Internal-role profile configuration format (authored, retained). | architecture |
| M7-G11 | missing | high | Recurring records and operations. | runtime-model (held) |
| M7-G12 | contradiction | high | Command-name spelling in the ledger. | protocol |
| M7-G13 | contradiction | high | Approval status after Goal cancel or Plan supersession (stored value). | protocol |
| M7-G14 | contradiction | medium | Who classifies Chat. | work-model (held) |
| M7-G15 | needs-code | medium | Deterministic Coordinator rules. | architecture |
| M7-G16 | contradiction | medium | Runtime labels. | architecture |
| M7-G17 | contradiction | medium | Coordinator scope. | architecture |
| M7-G18 | contradiction | medium | Direct Task Thread. | work-model (held) |
| M7-G19 | missing | medium | Task API members and numbers. | work-model (held) |
| M7-G20 | contradiction | medium | Steering delivery. | work-model (held) |
| M7-G21 | contradiction | medium | Stale Quick Chat call contract. | work-model (held) |
| M7-G22 | contradiction | medium | Administration Tool name. | mediation |
| M7-G23 | contradiction | medium | Action Center rows. | work-model (held) |
| M7-G24 | missing | medium | Composer gaps. | work-model (held) |
| M7-G25 | ambiguous | high | Tool touch counting (duplicate-effect risk). | architecture |
| M7-G26 | missing | medium | Goal interface and Coordinator. | work-model (held) |
| M7-G27 | ambiguous | medium | Chat result kinds and Items. | work-model (held) |
| M7-G28 | ambiguous | medium | Contract or default. | cross-cutting T5 |
| M7-G29 | missing | high | Security and schedule numbers. | runtime-model (held) |
| M7-G30 | ambiguous | medium | Unresolvable pointers. | cross-cutting T10 |
| M7-G31 | needs-code | medium | Prompts, schemas, evaluation sets. | architecture |
| M7-G32 | contradiction | low | Naming and counts. | mediation |
| M7-G33 | ambiguous | low | Preview size. | work-model (held) |
| M7-G34 | ambiguous | medium | Busy Thread on submit. | work-model (held) |
| M7-G35 | ambiguous | high | Authorization of model-called Goal mutations. | work-model (held) |
| M7-G36 | missing | high | Input hash for receipts. | protocol |

### M8: Product Surfaces, Generative Apps, Channels, And Deployment

| ID | Type | Severity | Finding | Group |
| --- | --- | --- | --- | --- |
| M8-G01 | contradiction | medium | Web operation counts 248, 244, 83, and 85 cannot all hold. | architecture |
| M8-G02 | contradiction | low | Roadmap-only list omits two operations; archive operations use camelCase names. | architecture |
| M8-G03 | needs-code | medium | No key-by-key table of the operation catalog and its dispositions. | architecture |
| M8-G04 | missing | low | Visual tiers, boards, token bridge, and parity tolerance undefined. | architecture |
| M8-G05 | contradiction | low | Implementation status, Composer, and retired Repositories screen statements conflict. | architecture |
| M8-G06 | ambiguous | low | A roadmap disposition names a closed roadmap item. | architecture |
| M8-G07 | missing | high | Read-receipt table, shape, and operations unnamed. | architecture |
| M8-G08 | needs-code | high | Generative Kernel SQLite DDL absent. | generative-apps |
| M8-G09 | contradiction | high | `schema_revisions` table in the layout specification but absent in the register. | generative-apps |
| M8-G10 | missing | high | Kernel format 1 and the upgrade to format 2 undefined. | generative-apps |
| M8-G11 | missing | medium | Snapshot, catalog, upgrade, and template operations absent. | generative-apps |
| M8-G12 | ambiguous | high | Collection and field identifiers: opaque UUIDs, prefixes, or UUIDv5 names. | generative-apps |
| M8-G13 | contradiction | high | Whether a populated field drop is enabled (data-loss decision). | generative-apps |
| M8-G14 | ambiguous | medium | `schemaRevision` after restore can reuse an old number. | generative-apps |
| M8-G15 | missing | medium | Canonical schema bytes and semantic-input hash undefined. | generative-apps |
| M8-G16 | ambiguous | medium | Kernel error codes not namespaced; HTTP statuses absent. | generative-apps |
| M8-G17 | contradiction | medium | Kernel and backup specifications defer the app package format to each other. | generative-apps |
| M8-G18 | contradiction | medium | Source-reference re-pointing extension has no interface. | generative-apps |
| M8-G19 | ambiguous | low | Kernel admission limits: contract or default. | generative-apps |
| M8-G20 | ambiguous | low | Whether `retired` is terminal in the initial release. | generative-apps |
| M8-G21 | ambiguous | high | Answer-source Item identifier derivation undeclared. | generative-apps |
| M8-G22 | missing | medium | A2UI grammar external; `generative_presentations` columns unnamed. | generative-apps |
| M8-G23 | ambiguous | high | Fresh root and markerless predecessor root not distinguishable. | fault-tolerance (held) |
| M8-G24 | ambiguous | medium | Order of the data-root lock and the integrity checks. | fault-tolerance (held) |
| M8-G25 | missing | medium | Lock holder fields, beacon interval, and shutdown deadline unnamed. | fault-tolerance (held) |
| M8-G26 | missing | medium | Boot diagnostics fields and overall state enum missing. | fault-tolerance (held) |
| M8-G27 | contradiction | medium | Boot target: pre-cutover files or the Draft control store. | fault-tolerance (held) |
| M8-G28 | missing | high | Mode selection, precedence, bind defaults, and secret source undefined. | identity |
| M8-G29 | contradiction | high | Local-mode bind host: loopback-only contract versus projection. | identity |
| M8-G30 | contradiction | medium | App image default mode: server in the specification, local in the cookbook. | topology |
| M8-G31 | ambiguous | medium | Proxy routes, internal port, and container user only in a cookbook. | topology |
| M8-G32 | contradiction | medium | Image packaging statements stale; candidate flow conflicts with release management. | topology |
| M8-G33 | contradiction | medium | Host requirements status and the Git pin rule conflict. | topology |
| M8-G34 | missing | medium | Host manifest probes and measures only in an external file. | topology |
| M8-G35 | missing | medium | Release manifest keys and `SHA256SUMS` scope conflict. | process |
| M8-G36 | missing | high | App update stdin, receipt, and stage schemas missing. | topology |
| M8-G37 | missing | medium | Operator Skill `doctor` schema and credential-store naming missing. | topology |
| M8-G38 | ambiguous | medium | Contract stability launch boundary undefined. | contract-evolution |
| M8-G39 | missing | high | Discord endpoint, configuration keys, time-to-live, and command grammar missing. | protocol |
| M8-G40 | missing | medium | Channel operation identifiers and notification table unnamed. | protocol |
| M8-G41 | ambiguous | medium | Roadmap expects Discord work start and progress; the specification covers attention only. | protocol |
| M8-G42 | missing | medium | Telemetry sink paths and the Turn-view operation missing. | evidence (held) |

## Assignment By Group

The table counts the findings that each group owns. A finding with two groups counts once for each group, so the total is 299 for 296 findings.

| Group | Findings | State |
| --- | --- | --- |
| storage | 50 | held |
| mediation | 41 | open |
| protocol | 29 | open |
| identity | 28 | open |
| knowledge | 27 | open |
| work-model | 21 | held |
| architecture | 17 | open |
| generative-apps | 15 | open |
| runtime-model | 11 | held |
| policy | 9 | open |
| vault | 9 | open |
| communication | 8 | open |
| topology | 8 | open |
| fault-tolerance | 6 | held |
| cross-cutting T5 | 4 | handled in each owning group |
| sandbox | 4 | open |
| evidence | 3 | held |
| agent-session | 2 | open |
| agent-supply | 2 | open |
| core-concepts | 2 | open |
| contract-evolution | 1 | open |
| cross-cutting T10 | 1 | handled in each owning group |
| process | 1 | open |

Held groups own 91 assignments. Those findings stay open until #440 releases the group.
