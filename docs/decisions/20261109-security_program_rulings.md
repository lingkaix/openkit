---
status: Accepted
date: "2026-11-09"
decider: Engineer
---
# Security Program Rulings

## Decision

1. **Three parts.**
   - Part 1, a repository spec: what the OpenKit project ships.
   - Part 2, a private operations library: the maintainers' own machines.
   - Part 3, a product mechanism: security inside every running instance.

   The maintainers' instances run part 3 as dogfood.
2. **Classes.** K is known exploited, or a malicious-package record (OSV `MAL-`), whatever its reachability: 24 h. C is critical: 72 h. H is high: 7 days. N is fixed at the next routine upgrade. All three parts use them.
3. **Release age.** npm packages must be at least 3 days old. A security fix is exempt through an exact-version exclusion that names the advisory id. Other ecosystems follow the rule by procedure.
4. **Part 3 v0.1.0 core.** Scheduled audit, advisory match for the instance's own components, passive defense basics, anomaly warnings, and agent response at propose-then-approve only. The work runs alongside acceptance. Passive defense lands before the authentication acceptance evidence is taken. The trigger lands after the durable engine cutover. Channel notification is response level L1.
5. **Requester.** Pending Requests gain the closed requester value `automation`, reusing the existing actor kind name. Like a person's, its outcomes are published by a Core-local Turn.
6. **Urgent reminder.** Each recipient's copy of a class K item still unanswered after 12 hours gets one durable reminder occurrence for that recipient. The reminder is a new request, not a transport retry. A restart never creates a second reminder.
7. **OpenKit OSV records.** `GIT` ranges on the repository URL, with the release tags listed in `versions`. No invented ecosystem.
8. **Recipients and destination.**
   - Recipients are server administrators, each in their own security Thread: a private Administration-entry Thread in that administrator's personal Workspace.
   - By default the responsible administrator receives each item. K findings, R1 and R8 go to every administrator.
   - Every channel interaction with a security request (delivery, `inspect`, `answer`) returns only fixed link text.
   - Acknowledging an item never counts as remediation. Unresolved findings reopen when due.
   - **Notice is per recipient.** Only an answer whose recorded actor is recipient B acknowledges B's notice. Another administrator's answer or withdrawal of B's copy uses unchanged administrator authority but never ends B's notice: attention uses the durable notice as its source, independent of the ended request, and B gets a new request to answer. Outstanding notices drain on their own lifecycle, independent of detection, after `off`, after delegation loss and across restart; alarm notices use the fixed alarm grant.
   - **Triage is per revision.** First-answer triage is serialized against a durable finding and assessment revision that records the deciding request. Disagreement is an idempotent transition to one unresolved conflict per revision; further answers are attributed evidence. The first answer to the conflict is the explicit decision for the current revision; there is no quorum. A late answer never overwrites a newer inventory-backed disposition such as `fixed`.
9. **Managed-instance GitHub access.** Instances that the maintainers deploy may file issues on the OpenKit repository. They never get Contents permission.

   | Element | Ruling |
   | --- | --- |
   | v0.1.0 (operations side) | One GitHub App per managed instance, with `issues: write` and `metadata: read` only, for non-security issues. The instance's Gateway GitHub binding resolves every write to `require_approval`, and the exact text is shown to the approver. |
   | Never | `contents`, `workflows`, `actions`, `administration`, `secrets`, `packages`, `repository_advisories`. Contents write would also reach releases and release assets, beyond any branch ruleset. Advisory permission would expose embargoed drafts. |
   | Pull requests | Later, from a separate fork repository with its own App. Pull requests into OpenKit need part 1's independent review. |
   | Security reports | Manual only. A person submits them through private vulnerability reporting. |
   | Credential | Until the product credential kind exists (after v0.1.0), an operations-side refresher supplies the 1-hour installation token to the existing Vault reference. Later, a Vault material kind holds the App key, and the Gateway mints tokens in memory. |
   | Third-party operators | They get every product mechanism for repositories they control. They get no access to the OpenKit repository. |
10. **Raising Turn.** The security trigger reuses the existing Core-local Turn contract, with no new Turn category.
    - The raising Turn runs no agent, uses no AgentSession and makes no Provider call. Its trigger source is `automation`.
    - Each request stays on its raising Turn. Its outcome goes to the later Core-local publication Turn, per Pending Requests. The trigger reads resolutions from the request records by id.
    - Busy, archived and revoked-recipient destinations and the crash recovery rules follow part 3 E4. Latency depends on destination admission.
11. **Investigation authority as Policy.** Security investigation runs as its own agent principal, on behalf of the asking administrator. Its Policy grant covers only the existing read operations and `administration.configuration.propose`. Every other operation is refused by the Kernel as not granted. A Task started from a report carries a fixed read-only envelope with no egress, credential or outbound grant. No Tool allowlist is added.
12. **Alarm before stop.** Turning monitoring off, or the loss of its responsible authority, enqueues the alarm durably before detection stops. Delivery uses a fixed system grant that is independent of the monitoring delegation. Each recipient must still be a current administrator.
13. **Pause.** "Pause agent work" refuses admission and dispatch of new agent execution only. Recovery, cancellation, answers, revocation, Core-local Turns and unpause stay available. It does not reuse shutdown admission.
14. **Release gate.** Every K or C finding in a release candidate needs one of three records:
    - a current `mitigated` record;
    - a reviewed `not_affected` record;
    - an unexpired `accepted` record decided by the engineer.

    This holds whether or not a fix exists. Triage of a private report starts at intake. Producing attestations (v0.1.0) is separate from verifying them on update (after v0.1.0).
15. **Security review gate in v0.1.0.** A restrict-only gate participant runs on the existing Policy binding seam and reaches its model through a new LLM Gateway request category, `decision`.
    - **Providers.** OpenAI Decisions (`POST /v1/decisions`) is the first native Provider. Any model with structured output is the bridged fallback.
    - **Outcomes.** Exactly three: allow, block or escalate. Allow contributes nothing, so the gate only restricts. Failures and timeouts escalate to the existing approval Pending Request.
    - **Points:**
      - outbound channel sends and issue filing;
      - Knowledge and Memory writes;
      - credential use and delivery;
      - MCP tool-definition changes.

      Each point fires at every risk point in an externally influenced agent context. The definition point always fires.
    - **Sticky influence.** One bit per agent context (on the AgentSession, or on the context record of sessionless agent work), set permanently by `remote-mcp`, `tool` or `import` Items, by channel input from anyone but the owner, by output from an influenced context, by absent or mixed ingress, and by reading Knowledge or Memory that carries the bit. It survives compaction, summarization, retention and reuse; Knowledge and Memory written from an influenced context carry it. Owner input is intent; pasted content is a named limit. Per-Item lineage is deferred.
    - **Input.** A structured action only, with no secret values; payload and definition text are untrusted data.
    - **Operation.** Decisions are cached and audited, within a latency budget. A route is activated only after it passes a synthetic eval with thresholds for block rate and false positives.
    - **No route configured, or unresolved.** An influenced context needs a person at each point; an unresolved gate never releases the effect.
16. **v0.1.0 cut.** Everything in the agreed core (item 4), plus:
    - the Item ingress fact, the influence bit and the security event list;
    - the CSP header;
    - the MCP tool-definition hold;
    - the narrow pause;
    - the review gate (item 15);
    - the item 17 core;
    - the item 18 ceiling;
    - the item 19 cut.

    Everything else, including administrator two-factor and step-up authentication, comes after v0.1.0 as a named deferral.
17. **Context-dependent permissions.** When an agent acts for a User, the agent is the principal, on behalf of the User (replaces `policy.md:119`; the responsible-human and domain checks stay; `mediation.md:60` keeps distinct roles and truthful attribution without inventing identities). For each agent operation, the existing Kernel evaluates the intersection of:
    - the agent's grant;
    - the on-behalf-of principal's current authority;
    - the context envelope (surface, conversation, initiative, audience).

    Only inside an explicitly established agent-initiated trigger context is the on-behalf-of grant absent; the agent grant and the narrowest preset then apply. This is never a fallback for a missing initiator. Credential restrictions stay enforced. The Kernel does this with existing attributes and no new engine. When a result is shown in a conversation, every read is bounded by that conversation's `OutputAudience`. Messages from other participants are untrusted input.

    The presets form a closed set:
    - owner direct message;
    - Workspace members;
    - agent-initiated;
    - external group.

    v0.1.0 ships the intersection, the audience rule and the first three presets. External groups come after v0.1.0.
18. **Policy administration scopes.**
    - **Defaults.** Policy ships with editable working defaults.
    - **Who writes where.** The Server administrator and the Goal Coordinator (an agent inside its human's envelope) each write Policy only in their own scope. A Workspace-administrator scope does not exist at 835ffb0a4; it comes after v0.1.0.
    - **Ceiling.** Every mutation needs current `policy.write`. The complete resulting diff is classified, including deletions and changed conditions, bindings and lifetimes. Removing a prohibition or weakening a required gate counts as widening. Every widened element must lie within the author's current authority, and no author approves their own widening.
    - **Audit.** Every write is audited.
19. **Unified credential model** (amends Identity; it is not a redesign).
    - **Rules:**
      - Every inbound credential selects exactly one principal and never adds authority; its scope and binding remain mandatory restrictions.
      - One lifecycle and one management surface (API, CLI and Web).
      - Child credentials are attenuated, and their revocation cascades.
      - Storage is opaque and hashed.
      - Sandbox credentials are run-bound.
    - **Not tokens.** Outbound secrets stay in the Vault. External channel people get no token.
    - **v0.1.0 cut:**
      - external MCP clients get their own `IntegrationIdentity` principal and token;
      - every inbound credential appears in one list with revocation, including the user's own Web sessions (the auth library already serves session list and revoke);
      - disabling the user stops that user's sessions and MCP client tokens;
      - pairing is audited as `channel.pairing.bind` and `channel.pairing.unbind`.
    - **Later.** Per-token principals for existing tokens, and administrator controls over other users' sessions.
20. **Security identifiers.** Request ids are UUIDv5 over a fixed JSON name (kind, item key, recipient, occurrence kind and number); Thread, Turn and Item ids use `deriveEntityId` over the request id or the recipient's Thread generation. The trigger is the only producer and its state owns every counter. Part 3 E4 is the producer declaration under the [identifier owner decision](20261015-identifier_owner_declarations.md).

## Reason

- **Items 1–4 and 16: engineer direction.** A known exploited vulnerability can be weaponized within hours, and a published malicious package is hostile by definition. Three days outlasts most malicious npm releases, and the exemption keeps fixes fast. A small, safe core fits v0.1.0.
- **Items 5 and 10.** `PendingRequesterKind` is a closed set. The person-requester path already shows how a Core-local Turn publishes outcomes. Decisions are never written back onto a terminal raising Turn.
- **Item 6.** A 24-hour class cannot rely on one delivery that may end as "unknown". Attention never repeats a sent or unknown delivery, so the reminder must be a new source.
- **Item 7.** OpenKit is not a package in any OSV ecosystem.
- **Item 8.**
  - Administration Threads exist only in personal Workspaces.
  - Shared Workspaces have equal members, so a finding in a shared Thread would reach every member.
  - An internal trigger does not manufacture Workspace membership.
  - Channel accounts are weaker credentials than App sessions.
- **Item 9.** Contents permission cannot be confined to bot branches: it also covers releases and their assets. A compromised instance key can call GitHub directly and bypass the Gateway.
- **Items 11 and 15.**
  - Every actor is a principal, and agent authority is delegated, attenuated and revocable.
  - A Policy grant is enforced at the Core boundary that every harness crosses. A Tool list would be a second authorization layer.
- **Item 12.** Otherwise a stolen session can stop the watch before it reports its own disablement.
- **Item 13.** Shutdown admission refuses every mutating operation, including the operations needed to recover.
- **Item 14.** A known exploited finding with no fix still needs a decision before it ships.
- **Items 15 and 17–19: engineer direction.**
  - Injection and poisoning need a check at the boundary, and the existing binding seam already provides timeouts, failure escalation, circuits and precedence. Because the gate never contributes allow, it cannot widen authority.
  - Without the intersection and the audience rule, a participant can use the agent to move data into a room.
  - Without per-client principals, an MCP client cannot be restricted or revoked apart from its user.
- **Item 15, sticky influence.** A remote Tool result summarized into model output, then compacted away, would otherwise reach a gated effect with only `provider` ingress in view.
- **Item 8, separate notice.** An ended request is ineligible for unsent attention, and an administrator may answer or withdraw another user's request, so tying acknowledgement to request state would let one stolen session suppress every other administrator's alert. An unbounded conflict rule would let two answers generate requests without new evidence.
- **Item 18, full diff.** Checking only added grants misses a deleted prohibition or a deactivated gate, each of which widens effective authority.
- **Item 20.** The identifier owner decision requires complete derivation inputs, trigger and recovery for every UUIDv5 producer.

## Rejected Alternatives

- **One App with advisory permission, for automatic private reports.** It exposes embargoed advisories.
- **Same-repository Contents write limited by rulesets.** Release assets stay writable.
- **A personal or machine-user token per instance.**
- **Silent redaction of outbound text.**
- **A model-written warning, a model-chosen class, or an Administration-agent Turn that posts the report.** Each puts a model on the alert path.
- **A new Core-executed Turn category.** The Core-local contract already covers it.
- **A gate that may allow, an OpenAI-only gate, or a gate on every operation.**
- **A gate that fires only when external Items are in the current Turn's view.** Summaries and compaction launder influence.
- **Per-Item content lineage in v0.1.0.** Precise but costly; the sticky bit over-counts safely.
- **Ending every administrator's copy when the first one answers.**
- **Free-form permission matrices per conversation.**
- **JWT, macaroons or Biscuit for inbound credentials.** Core verifies every request online, and attenuation lives in Policy.
- **Per-Workspace or Server security Threads in v0.1.0.**
- **A bespoke Tool allowlist for investigation.**
- **A general 12-hour reminder, or reusing transport retry for reminders.**
- **An invented OSV ecosystem.**

## Revisit When

- Instance security reports become frequent. Then consider a private intake repository with issues-only access.
- GitHub adds branch-scoped contents permission or report-only advisory permission.
- L3 containment is designed. The stop control and the evidence-first rule apply then.
- Workspace-scoped signals or the Workspace-administrator Policy scope are designed (deferred list).
- Gate costs from the sticky bit become material. Then consider per-Item lineage.

## Affected Owners

- docs/core/security.md (new charter) and docs/core/README.md; the development security spec (new) and the runtime security spec (new).
- docs/toolchain.md; docs/specs/20260829-release_management.md; docs/specs/20260708-container_image_packaging.md; docs/specs/20260721-worker_execution_environment_images.md; docs/specs/20260910-app_update_delivery.md.
- docs/core/identity.md; docs/specs/20260704-remote_auth_credential_bootstrap.md; docs/specs/20260526-llm_gateway_responses_api.md; docs/core/mediation.md.
- docs/core/protocol.md; docs/core/agent-session.md; docs/specs/20260704-agent_session_continuity.md; docs/specs/20260902-agent_runtime_context_compaction.md; docs/core/knowledge.md; docs/specs/20260703-knowledge_store_implementation.md; docs/specs/20260909-personal_memory_and_knowledge_learning.md; docs/specs/20260704-chat_mode_assistant.md; docs/core/policy.md; docs/specs/20260629-openkit_policy_model.md; docs/specs/20260930-pending_requests.md; docs/core/communication.md; docs/specs/20260711-scheduler_recurring_event_triggers.md; docs/specs/20260703-audit_usage_evidence_records.md; docs/specs/20261017-retained_format_register.md; docs/specs/20260704-nanocore_bootstrap_readiness.md; docs/specs/20260704-worker_mcp_tool_supply.md.
- `SECURITY.md`, `CONTRIBUTING.md`, `.github/workflows/README.md`; the docs/specs and docs/decisions README indexes. Root `AGENTS.md` is not edited; any root contract change is a protected-owner action outside lane scope.
