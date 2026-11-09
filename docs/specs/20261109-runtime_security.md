---
status: Accepted
implementation: Not Started
kind: mechanism
date: "2026-11-09"
---
# Runtime Security

## Owns

The runtime values and workflows that the [Security](../core/security.md) charter leaves to specifications, inside one instance: passive defense, inventory, feeds and matching; the security trigger, its events, rules and identifiers; notification placement, investigation authority and the pause; the review gate's points, influence rule and decision request; the conversation presets; the inbound credential list; upstream routes.

## Does Not Own

The charter's principles, terms, threat model and invariants; Policy, Identity and Mediation semantics, which this spec amends through their owners; classes, response targets and release security ([development security](20261109-development_security.md)); hosts, networks, backups, Sandbox containment and ordinary model content safety.

## Core References

[Security](../core/security.md), [Doctrine](../core/doctrine.md), [Identity](../core/identity.md), [Policy](../core/policy.md), [Mediation](../core/mediation.md), [AgentSession](../core/agent-session.md), [Knowledge](../core/knowledge.md), [Communication](../core/communication.md), [Protocol](../core/protocol.md), [Sandbox](../core/sandbox.md), [Evidence](../core/evidence.md).

## Summary

An instance reachable from the Internet must notice when its components become vulnerable or its credentials are attacked, tell a person fast, and help them respond without giving an attacker a new lever.

- **Detect and notify.** Throttling, an SBOM inventory with stated gaps, bounded feeds, and one closed trigger (daily advisories, 5-minute audit watch) that writes items, with no model, into each administrator's own security Thread. Channels get fixed text only.
- **Respond.** A read-and-propose investigation principal; a narrow pause.
- **Restrict and bound.** A restrict-only gate at risk points in externally influenced agent contexts; agent operations bounded by agent grant ∩ initiator authority ∩ conversation envelope, and replies by their audience.
- **Credentials.** One principal per inbound credential, one list, one revocation path.

Every check sits at a Core boundary that every harness and Sandbox backend crosses (charter principle 10).

## Goals / Non-goals

**Goals:** advisory matches with class and deadline within a day; credential attacks and sensitive events reported within one watch interval; people reached outside the App; risk-point effects of influenced contexts checked at the boundary; one place to see and revoke inbound credentials; usable by any operator.

**Non-goals:** host intrusion detection; defense against a malicious sole administrator; network DoS; reachability analysis; automatic repair; Workspace-scoped signals in v0.1.0; gating App update admission on findings in v0.1.0 (findings gate only the release, part 1).

## Background

At 835ffb0a4:
- **Authentication.** No bearer-failure audit and no explicit sign-in limiter (`auth/middleware.ts`). Session list and revoke are served by the auth library (`app.ts:1934`, `auth/better-auth-adapter.ts:24–28`), with no Web view.
- **Pending Requests.** Closed requesters; a later Core-local Turn publishes outcomes; one non-terminal Turn per Thread; Core-local Turns have no AgentSession (`protocol.md:209–211`); an ended source is ineligible for unsent attention (`20260930-pending_requests.md:304`).
- **Attention and Discord.** No repeat of a sent or unknown delivery; audience and account are rechecked synchronously (`notifications/attention.ts:48`, `channels/discord.ts:48,59`); `inspect` returns request content (`discord.ts:518–540`); direct messages only.
- **Administration entry.** A private Thread in the personal Workspace; Tools run as the human (`administration-tools.ts:5–14`).
- **Policy.** The Subject separates principal, actor and on-behalf-of (`policy.md:117`); an agent acting for a User evaluates as the User (`:119`); `OutputAudience` bounds Assistant output (`:303–311`). Policy is one Server document applied through configuration (`policy/configuration.ts:95–135`), and `preparePolicyDocument` classifies the full diff (`policy/statements.ts:388–457`). No Workspace-administrator Policy writing exists.
- **Gate seam.** Binding states `inactive`, `shadow`, `active`; timeout ≤ 60 s; failure `escalate-to-human`; circuit breaker (`policy-v1.ts:133–165`); transient output; `combineResults` ranks `allow` last and the final Kernel evaluation always runs (`interception.ts:643–660`).
- **Gateway** capabilities cover only chat completions and responses (`profile-capabilities.ts:5–10`). **Admission** has only the shutdown refusal (`app.ts:396–411`).

## Threat Model

The charter's threat model applies. This spec answers its runtime rows: credential stuffing and theft (E1, R2, R3, E11); vulnerable or malicious components (E2–E4); injection steering effects or poisoning Memory and Knowledge (E9, exact-text approval); injection against the response path (code-written alerts, E7); hostile feeds (E3); silencing the monitor (E4 alarm first, E6 per-recipient notices); leaking into a shared room (E10); denial of wallet (Gateway and gate budgets).

## Decision

One mechanism composed from existing owners, with no new approval model, scheduler, notifier, Turn category or authorization engine: E1–E8 (detection, notification, response), E9 (review gate), E10 (context permissions and Policy administration), E11 (credentials) and the pause, each at the v0.1.0 cut stated below. The rulings are in [Security Program Rulings](../decisions/20261109-security_program_rulings.md).

## Contract / Expected Behavior

### Response Levels

The charter defines L0–L4. In v0.1.0: L0 and L1 are Core code; L2 is the investigation principal or a Task a person starts. L3 and L4 come later.

### Passive Defense (E1)

- **Sign-in.** The auth library's limiter per source and per account, with backoff. The source is the transport peer; forwarded headers count only after an administrator sets the trusted proxy hop count.
- **Bearer failures** are counted per source, never throttled.
- **Revoked-credential signal.** Recorded only when the presented secret verifies against a stored token that is `revoked`, `expired` or `rotated`, so a guessed id frames no one.
- **Counters** are process-local and bounded; each threshold crossing writes one record (E5).

### Self-Inventory (E2)

| Source | Read from | Coverage |
| --- | --- | --- |
| OpenKit release | Build metadata | Always |
| App image | Embedded SBOM (part 1) | Official images |
| Worker images, NanoHost | Release SBOMs, verified against `SHA256SUMS` | Official artifacts; derived images not covered |
| MCP servers | — | Not covered: the catalog keeps transports and optional digests, not package identities (`mcp-catalog.ts:67–83`) |
| Skills, Light Apps, plugins | — | Not covered |

Every report states its coverage and gaps with reasons. A missing SBOM shows as "unavailable", never as empty.

### Advisory Feeds (E3)

Feeds are Server configuration that only administrators change. Kinds are closed:

| Kind | Behavior |
| --- | --- |
| `osv-api` | `querybatch` with inventory purls, then a fetch per match. Discloses the component list to the endpoint, and settings say so. Mirrors allowed. |
| `osv-records` | OSV JSON from an HTTPS URL or local path; exact `versions` and `SEMVER` ranges. OpenKit's own records use `GIT` ranges with tags in `versions`. |
| `kev` | CISA KEV JSON; enrichment only: a match raises the finding to K. |

- **Defaults.** On enable, the view suggests all three for confirmation.
- **Classes and targets** are part 1's, shared by both specs. A `MAL-` record is K. Feeds only add findings or raise classes; only a person's answer changes a disposition, and only for that finding.
- **Bounds.** 10 s connect and 60 s total per request; 32 MiB and 100,000 records per document, streamed; 5 minutes per feed run. `osv-api` follows no redirects; other kinds follow up to 3, same origin only. Truncation marks coverage "incomplete"; malformed records are skipped and counted.
- **Isolation.** Each feed is its own bounded step; the watch never waits on a feed; no failure clears a finding. A finding becomes `fixed` only when the inventory no longer contains the matched version.
- **Feed text** is untrusted: stored quoted under the feed name, never executed, never choosing an upgrade target.

### Security Trigger (E4)

**Trigger and grants.** One closed Server trigger on the recurring trigger owner's interface, off by default, running daily and every 300 s, moving with that owner through the durable engine cutover. No run calls a Provider.
- **Delegated grant.** The trigger is an `automation` principal. The enabling administrator delegates a fixed grant: read Server audit and the inventory, call the configured feeds, raise security requests to current server administrators. It never exceeds that administrator's authority and is suspended when that authority ends (`policy.md:123`).
- **Alarm grant.** A separate fixed system grant raises the monitor alarm (R1 "monitoring off", R8) with fixed text to every current administrator, so revoking the delegation cannot silence it.

**States** (`off` → `on` → `stopping` → `off`). Turning off sets `stopping` and inserts the R1 alarm rows in one transaction; detection continues until every alarm row is raised or its recipient is no longer current. Each run checks authority first; on loss it sets `stopping`, records the reason, inserts R8 rows and uses only the alarm grant. A loss found after a crash records a gap outcome (R8). Restart resumes `stopping`. Reaching `off` ends detection only; outstanding notices keep draining (below).

**Transactions**, each inside one store; a crash repeats only the later step:
1. **Detect** (Core SQLite). Read audit after the cursor; advance the cursor and insert outbox rows, each with its identifier inputs, in one transaction.
2. **Raise** (Pending Requests, Core-local path). For an idle destination, admit a Core-local Turn with trigger source `automation` in the recipient's security Thread; it writes the report Artifact Item and the request. Complete tuples are reused; partial tuples become `recovery_required`.
3. **Mark and enqueue.** Mark the row raised, then enqueue attention with the recipient notice as its source, idempotent per notice.

**Destinations.** Busy: wait for the terminal barrier or the next run. Archived: closeout ends its open requests, and the next run raises unresolved items again, as `reopen` occurrences, in the next-generation Thread. Recipient no longer an administrator: nothing is raised, and their open requests end with a fixed reason. No eligible recipient: a failed outcome in settings. Latency is one run interval for an idle destination, otherwise the next terminal barrier. A Core-local publication Turn publishes outcomes, read by request id.

**Notice drain.** Each outbox row is an outstanding recipient notice until its recipient acknowledges it (E6) or stops being a current administrator. Delivering outstanding notices is a lifecycle separate from detection: the drain runs at boot and every 300 s while any notice is outstanding, whatever the trigger state, including after `off`, after delegation loss and across restart. It reads no audit or feed; it only performs Raise and Mark and enqueue for existing rows, including `renotice` requests. Alarm notices (R1 "monitoring off", R8) drain under the fixed alarm grant. Other notices drain under the delegated grant; while it is suspended they stay outstanding, and the R8 alarm reports why. Another actor's answer or withdrawal never ends a notice.

**Identifiers.** The producer declaration required by the [identifier owner decision](../decisions/20261015-identifier_owner_declarations.md). The trigger is the only producer, and its state owns every counter.

| Id | Derivation | Inputs |
| --- | --- | --- |
| Request | `uuidv5` (URL namespace, `generative-kernel/uuid.ts`) over the JSON text `{"kind":"security-request","key":K,"recipientUserId":U,"occurrence":{"kind":O,"n":N}}` | K is `["finding", feedId, purl, advisoryId]`, `["event", auditEventId]` or `["gap", enableGeneration, gapKind, runId]`. O is `initial`, `reopen`, `reminder`, `renotice` or `conflict`. N counts from 1 per (K, U, O), assigned when the outbox row is inserted; for `conflict`, N is the triage revision. |
| Security Thread | `deriveEntityId('th', ['security', U, G])` | G is the recipient's Thread generation, from 1; Raise increments it in its own Core SQLite transaction when it finds that generation archived |
| Raise Turn; status Turn | `deriveEntityId('tu', ['security-raise' or 'security-status', requestId])` | One status per copy (E6) |
| Items | `deriveEntityId('it', [requestId, role])`, role `report`, `request` or `status` | The capability id stays the owner's (`pending-requests.ts:553`) |

Retry and recovery recompute every id from the stored row, so a retry finds its earlier tuple. Independent allocations, such as audit event ids, stay UUIDv7.

### Event List And Rules (E5)

The v0.1.0 list contains only Server-scope events and reuses existing names. Each row has a fixture. A record missing a required field is reported as unsupported; where a producer lacks a field, its owner adds it.

| Event | Producer | Required fields | Rule |
| --- | --- | --- | --- |
| `auth.token.issue` | Access-token operations | Token id, scope, owner, principal, actor, expiry | R1 if `server-admin`; else R1d |
| `auth.token.revoke`, `auth.token.rotate` | Access-token operations | Token id, scope, actor | R1d |
| `auth.admin-recovery.issue` | Administrator recovery | Target user, actor | R1 |
| `auth.bootstrap.consume` | Bootstrap | Actor | R1 |
| `administration.configuration.apply` | Configuration apply | Changed sections, actor | R1 for the security section; else R1d |
| `server.config.update` | Server configuration | Changed keys, actor | R1d |
| `policy.write` | Policy administration | Scope, full-diff classification, actor | R1d if widening |
| `user.disable` | User administration | Target, actor | R1d |
| `app.update.start` | App update | Target digest, actor | R1d |
| `channel.pairing.bind`, `channel.pairing.unbind` (new) | Channel pairing | Channel kind, user, binding revision, actor | R1 if the user is a server administrator; else R1d |
| `auth.failure-threshold` (new) | Limiter, bearer middleware | Kind, key kind, window, count | R2, R4 |
| `auth.revoked-credential-presented` (new) | Bearer verifier | Token id, scope, status, source | R3 |

| Rule | Default threshold | Notify |
| --- | --- | --- |
| R1 Sensitive event (including pause set or cleared) | Every event | Immediately, every administrator |
| R1d Change digest | Every event | Daily; immediately if the actor is not the responsible administrator |
| R2 Sign-in failures | 10 per account or 50 per source in 15 minutes | Immediately |
| R3 Revoked credential | First event for an administrator token; 5 per hour for others | Immediately |
| R4 Bearer failures | 100 per source in 15 minutes | Daily; immediately if it repeats the next day |
| R8 Monitor gap (cursor gap, missed run, lost authority) | Every case | Immediately, every administrator, under the alarm grant |

R5–R7 and R9–R11 are deferred: their inputs are Workspace-scoped or their producers are not fixed, and a Server trigger gains no Workspace membership (`policy.md:82`).

### Notification (E6, L1)

**Placement.** Each recipient's own security Thread: a private Administration-entry Thread in their personal Workspace, created by Core (Identifiers above). Each raise rechecks that the recipient is a current server administrator and that the Thread is theirs and not archived. There are no shared security Threads.

**Request and routing.** Each item becomes a `user-input` Pending Request from `automation`, routed by attention to Action Center, Needs you and paired channels. The responsible administrator receives each item by default. K findings, R1 and R8 go to every administrator.

**Choices.** All request and channel text comes from fixed templates.
- **Findings:** "Will fix by \<date>" (an acknowledgement with a target no later than the class deadline; the disposition stays `open`); "Mitigated, with the control"; "Not affected, with a reason"; "Accept until \<date>, with a reason". `fixed` is set by code only (E3).
- **R1:** "Expected" or "Not expected"; "Not expected" links to the credential list.
- **Other items:** "Reviewed" or "Start a response".

**Acknowledgement is not resolution.** An `open` finding whose target date passes, an `accepted` finding whose expiry passes, and any finding whose class a feed raises get a new triage revision and a `reopen` occurrence.

**Notice is per recipient.** Each outbox row is one recipient's notice, with its own request.
- Only an answer whose recorded actor is that recipient (`20260930-pending_requests.md:108`) acknowledges it. Administrator answer and withdrawal authority is unchanged (`policy.md:72–76`), but it is not proof that the recipient saw the notice.
- Another actor's answer or withdrawal of B's request never ends B's notice. Attention uses the durable notice as its source, so eligibility is the notice being outstanding plus the existing recipient, audience and channel-account checks, independent of the ended request. The drain (E4) also raises a `renotice` request for B to answer, at most one open per item and recipient.
- Copies stay open after the item is decided; Core adds a status Item naming the decider and the outcome.

**Triage is per revision.** Each item has a durable triage record in trigger state: a revision, the decision with its deciding request and actor, and a conflict flag.
- The revision advances on every inventory-backed or assessment change (new match, raised class, `fixed` by rescan, reopen). Each request records the revision it was raised for.
- The trigger applies published outcomes in resolution order, one Core SQLite transaction each. On a revision with no decision, the first answer decides.
- A later differing answer on that revision sets the conflict once: the finding returns to `open` (R1: "Not expected") and one `conflict` occurrence goes to every administrator. Further answers on that revision are attributed evidence and create no further conflict. There is no quorum.
- The first answer to the `conflict` occurrence is the explicit decision for the current revision.
- An answer for an older revision is evidence only and never changes the current disposition: an old "Accept" arriving after `fixed` leaves `fixed`.

**K reminder.** A K copy unanswered after 12 hours gets one `reminder` occurrence for its recipient: a new request, not a transport retry, so an unknown first delivery does not block it.

**Bounds.** At most 8 open security requests per Thread (owner limit 16); overflow becomes one "more in the report" request.

**Fixed channel text.** For an `automation` request, the Discord adapter answers delivery, `inspect` and `answer` with the same fixed text: a deadline word and the App link, for example "OpenKit security: action needed within 24 hours." It issues no disclosure token and refuses answers, so no finding detail leaves the App.

### Investigation Authority (E7, L2)

**Principal.** In a security Thread, an Administration Turn executes as the agent principal `security-investigation`, on behalf of the asking administrator.

**Grant.** The existing read operations (configuration and schema, environment list and status, runtime target) plus `administration.configuration.propose`. The Kernel refuses dispatch, prepare, recover and every other effect as `deny` (`not_granted`) before any effect. Tools are unchanged; Policy decides, with no Tool allowlist. The Tool adapter must pass the Subject {principal: agent, on behalf of: administrator}; Policy adds one bounded grant on the delegated Git-read pattern ([delegated Worker policy maintenance](20260922-delegated_worker_policy_maintenance.md)).

**Tasks.** "Start a Task from this finding" pre-fills `task.start` with a fixed brief and envelope: no egress, no credential grants, no outbound or MCP write bindings, read-only files. The Worker gets that envelope intersected with its resources (`policy.md:267`), and continuations keep it.

**Proposals.** A person applies every proposal through existing commands. Untrusted text is shown quoted and truncated.

### Upstream Reporting (E8)

| Found | Route |
| --- | --- |
| Public advisory against a component | Nothing upstream; update or rebuild |
| Suspected OpenKit vulnerability | "Prepare private report" drafts an Artifact; a person submits it through private vulnerability reporting |
| Non-security defect, managed instance | A person-started Task files an issue through the Gateway GitHub binding (Issues only), under `require_approval` with the exact text; no pull requests in v0.1.0 |
| Any defect, third-party operator | A draft and a link, or the operator's own binding |

### Security Review Gate (E9)

A second, fast model checks risk points, as Claude Code auto mode and Codex auto-review do. It is a gate participant on the existing binding seam.

**Ingress fact.** An optional closed `ingress` field on Items, written by Core at the receiving boundary only: `api` (App API or CLI), `remote-mcp`, `channel`, `provider`, `tool`, `import`, `core`. It names the boundary that received the bytes, not authorship or trust, and no authorization reads it except as the source of the influence bit.

**External influence.** One conservative bit per agent context: on the AgentSession ([AgentSession](../core/agent-session.md)), or, for sessionless agent work such as the Assistant's and Coordinator's rolling context, as a fact on the executing Turn and every Turn that continues it ([Protocol](../core/protocol.md)), carried through rolling context and compaction by the [context compaction](20260902-agent_runtime_context_compaction.md) owner.
- **Sources.** The bit is set, permanently, when the context takes in an Item with ingress `remote-mcp`, `tool` or `import`, or with absent or mixed ingress; `channel` input from anyone but the owner; output, a handoff or a sub-agent result from an influenced context; or Knowledge or Memory that carries the bit.
- **Persistence.** It survives compaction, summarization, retention and reuse. A Turn that resumes, forks or reuses the context inherits it. A context with no recorded value, such as one created before this change, counts as influenced.
- **Spread.** Knowledge and Memory written from an influenced context carry the bit.
- **Owner input.** Input from the owner (the principal the context acts for) through `api` or their own `channel` is intent and does not set it. Pasted content is the charter's named limit. Per-Item lineage is deferred.

**Points in v0.1.0.** Each fires in every influenced context; the Tool-definition point always fires.

| Point | Operations |
| --- | --- |
| Outbound | Channel sends to anyone but the requester's own direct message; Gateway GitHub issue writes |
| Knowledge and Memory | Knowledge publication; Memory writes |
| Credentials | Vault delivery to a Worker; Gateway credential use for a target new to the Turn |
| Tool definition | Approval of a held MCP definition change |

**Tool-definition hold.** When a binding changes a tool's name, description or schema, the tool stays unexposed until an administrator approves the new schema digest, after the gate. It catches changed interfaces, not changed behavior behind them.

**Gateway `decision` category.** A third request category beside chat completions and responses: a structured action and one closed question, answered from a closed set. Capabilities gain `decisions: native | bridged | unsupported`.
- **Native, first: OpenAI `POST /v1/decisions`** ([guide](https://developers.openai.com/api/docs/guides/decisions)), model `gpt-6-luna`, one `input_json` message, one `choice` question `verdict` (`allow`, `block`, `escalate`); the answer carries `probabilities` and `confidence`, or a `refusal`.
- **Bridged.** Any route with structured output gets the same question as a strict JSON schema, so operators without OpenAI keep the gate.
- **Usage.** Auxiliary (the Turn's primary model choice does not bind it), counted as `decision`. Client access comes later.

**Binding.** Activating a route that passed the eval writes ordinary Policy statements: an `agent-principal` `security-review` with no grant beyond its input disclosure, and one `gate` binding per point at stage `decide`, failure `escalate-to-human`, timeout 2,000 ms. The existing participant provider sends one decision request instead of running its loop.

**Input.** Principal and on-behalf-of, operation, target, destination audience and influence sources. Outbound effects add their exact payload (≤ 8 KiB); definition changes add both digests and the bounded new text. That text is marked as untrusted data. No secret values, only Vault reference names; the influencing content itself is not sent.

**Mapping.** Output `{decision, reasonCode, confidence?}` stays transient; evidence keeps its digest.

| Gate answer | Contributed result |
| --- | --- |
| `allow` at or above the threshold (default 0.9) | `not_applicable` |
| `block` | `deny` |
| `escalate`, a lower probability, `refusal`, timeout, malformed output, open circuit, exhausted budget | `require_escalation` |

**Restrict-only.** The gate never contributes `allow`, never satisfies `require_approval`, and the final Kernel evaluation still runs. Escalation becomes the existing approval Pending Request bound to the proposal digest (`policy.md:291`), so an unresolved gate never releases the effect. Adding no authority, it is not an agent approver and needs no shadow period (amendment to `policy.md:263`).

**Without a decision route,** an influenced context needs a person at each point: approval for outbound effects and credential use, Review proposals for Knowledge and Memory writes, administrator approval for definition changes.

**Cache, budget, audit, latency.** Cache keyed by (binding version, Policy revision, action digest, influence sources): 10,000 entries, 24 h, `allow` and `block` only. Budget: 2,000 requests per Workspace per day, then escalation. Each invocation, cache hits included, is part of the PermissionDecision record with its Gateway usage record. At most 1 s added at p95.

**Eval.** At least 200 public-safe synthetic cases across the four points, half injection (exfiltration through a reply or issue, planted Knowledge, an unexpected delivery target, a poisoned tool description, an instruction carried through a summary) and half the same operations without injection. A route is offered only if it blocks or escalates ≥ 95% of injection and ≤ 5% of benign cases, meets the latency budget, and never widens a Kernel result. Settings show its latest result.

### Context-Dependent Permissions And Policy Administration (E10)

**Agent principal (amends `policy.md:119`).** When an agent acts for a User, the principal is the agent, on behalf of the User. The responsible-human and domain checks stay (`policy.md:121–123`). Principal, actor and on-behalf-of remain distinct and truthfully recorded; an agent presenting the User's own credential is attributed to the User, with no invented identity (reconciles `mediation.md:60`).

**Intersection.** For each agent operation, the Kernel takes the most restrictive result of:
1. the agent principal's grant;
2. the on-behalf-of principal's current authority;
3. the context envelope, matched by preset statements against proposal attributes: `context.surface` (`app`, `channel-direct`, `channel-group`), `context.conversation`, `context.initiative` (`requested`, `self`) and the resolved destination audience.

These are existing Kernel attributes; no new engine. Credential restrictions such as Token scope stay enforced alongside.

**Self-initiated work.** Only inside an explicitly established agent-initiated trigger context (a scheduled job or trigger whose definition records the agent, its responsible human and its targets) is the on-behalf-of grant absent. The agent's grant and the Agent-initiated envelope then apply. Absence is neither an empty grant nor a missing constraint, and it is never a fallback: an agent operation with no initiator outside such a context is refused. Task and Goal Workers keep their existing delegated envelope (`policy.md:265–273`).

**Audience rule.** When a result is shown in a conversation, every read for that Turn is bounded by the conversation's `OutputAudience` before generation. This extends the Assistant rule (`policy.md:303–311`) to every agent reply in shared Threads and channels. An @mention never moves what the mentioning person may see into the room. Messages from anyone other than the on-behalf-of principal carry no authority and set the influence bit.

**Presets.** A closed set; the surface selects one in v0.1.0.

| Preset | On-behalf-of | Audience | Envelope | v0.1.0 |
| --- | --- | --- | --- | --- |
| Owner direct message | Owner | Owner | Owner's ordinary grant | Yes |
| Workspace members | Asking member | Current members | Workspace-shared material only; effects need the asker's grant | Yes |
| Agent-initiated (narrowest) | Absent | The destination's | Agent grant limited to the targets the trigger definition names; every outbound effect through E9 or approval | Yes |
| External group | The mentioning user if paired; otherwise none | Everyone present | Material shared to that conversation only; no credential use; replies only there | After |

**Policy administration.**
- **Defaults.** The admitted Server Policy document ships with working defaults, including the presets and the E7 and E9 statements. Administrators may edit them.
- **Scopes in v0.1.0.** The Server administrator, for the Server Policy document; the Goal Coordinator, for its Goal domain inside the human's envelope (`policy.md:265–273`). The Workspace-administrator scope is new and comes after v0.1.0.
- **Ceiling.** Every mutation needs current `policy.write` in its scope. The check classifies the complete resulting diff, as `preparePolicyDocument` already does: additions, deletions and changed conditions, bindings or lifetimes. Removing a prohibition, extending an allow statement's lifetime, or weakening a required gate (removing it, moving it from `active` to `shadow` or `inactive`, changing its failure handling, shortening its lifetime) counts as widening. Every widened element must lie within the author's current effective authority in that scope, and no author approves a change that widens their own authority.
- **Lifetime and audit.** Statements end when the author's authority ends (existing). Every write is audited as `policy.write` with scope and classification (E5).

**v0.1.0 cut.** Everything above for channel-triggered Turns, the investigation and review principals and MCP clients, with delivery to an unresolved audience refused, the first three presets, and both existing scopes. Group conversations, external-person principals, agents joining conversations on their own and the Workspace-administrator scope come later.

### Unified Credential Model (E11)

This section amends [Identity](../core/identity.md), which already defines the `Token` family (owner, scope, type; `active`, `expired`, `revoked`, `rotated`), `ActorRef`, `AutomationIdentity` and `IntegrationIdentity`. Identity answers who; Policy answers whether.

**Inventory at 835ffb0a4.**

| Credential | Binds to | Lifecycle |
| --- | --- | --- |
| Bootstrap token | The first administrator, on consumption | 24 h, single use, audited |
| Access token `okt_` (scope `server-admin`, `workspace` or `workspace-readonly`) | Owner user | Expiry, rotation, revocation, audited |
| Administrator recovery | Target administrator, as a `server-admin` Token | Token lifecycle, audited |
| Web session | User | Expiry and fresh age; revoke served without a view; refused for disabled users |
| Remote MCP client (an ordinary `okt_` Token) | The user, indistinguishably | Token lifecycle |
| Worker route tokens | The Worker run | Run lifetime, in memory |
| NanoHost transport token | NanoHost host | Token status values, audited |
| Discord pairing | User and Discord account | Single-use challenge; not audited |

Refresh tokens and agent-to-agent credentials do not exist. Discord ingress is a platform signature plus the verified sender id, not a credential.

**Rules** (ablation in italics):
1. **One principal per inbound credential.** The credential selects exactly one principal; its scope and binding remain mandatory restrictions alongside Policy; it never adds authority. *Else an MCP client cannot be restricted or revoked apart from its user.*
2. **One list and one surface (API, CLI, Web)** for issue, list, rotate, revoke and expiry, over each kind's existing store. *Else theft response means searching five places.*
3. **Attenuation.** A child credential's principal acts on behalf of its issuer, so the E10 intersection bounds it; nothing is encoded in the token. *Else a child could exceed its issuer.*
4. **Cascading revocation.** Verification requires every issuer up the chain to be active. *Else children outlive a revoked or disabled issuer.*
5. **Opaque, hashed, online-verified** (as today). JWT, macaroons and Biscuit are rejected: Core checks every request against its own store and attenuation lives in Policy, so offline formats only add key rotation and revocation lag.
6. **Sandbox credentials** stay short-lived, run-bound and in memory, listed as run rows; ending the run revokes them.

**Outside the family.** Outbound secrets (Provider keys, the Discord bot token, GitHub App keys) stay in the Vault. External channel people get no token; they map to an `IntegrationIdentity`-style principal by verified sender id, with no default grant (after v0.1.0).

**v0.1.0 cut.**
- **MCP client principal.** Issuing a token "for an MCP client" creates an `IntegrationIdentity` owned by the user and binds the Token to it. The chosen scope (`workspace` or `workspace-readonly`, never `server-admin`) stays on the Token and is the principal's default grant. Calls are evaluated on behalf of the user (E10) and attributed to the client. Existing user tokens keep working.
- **Credential list.** Each user sees and revokes their own Tokens (including MCP client tokens), Web sessions (through the served endpoints), Discord pairings and run rows. Server administrators also see NanoHost transport tokens and, within the existing token operations' authority, other users' Tokens; `user.disable` ends another user's sessions and MCP client tokens.
- **Audit.** Pairing and unpairing are recorded as `channel.pairing.bind` and `channel.pairing.unbind` (E5).
- **Identity amendment.** An `IntegrationIdentity` may be user-owned and span Workspaces; a Token binds to exactly one principal.

*Ablation:* without the cut, MCP clients act as the user, which E10 cannot bound. The rest is refactoring with no new protection before v0.1.0.

### Pause

- **Control.** Any current administrator may set or clear "pause agent work" without approval; doing so raises R1.
- **Refused:** admission and dispatch of new agent execution: agent-executed Turns, Task and Goal starts, scheduled agent work, outcome-initiated agent Turns (which wait), and Gateway requests from remote clients.
- **Still available:** authentication, reads, answers, cancellation, revocation, user disable, configuration apply, Core-local Turns, recovery and unpause.
- **In flight.** An admitted but undispatched Turn is refused at dispatch. Running Turns continue unless the administrator also chooses "cancel running agent Turns".
- **Persistence.** Server configuration, read at boot before scheduling; it does not reuse `acceptingProductWork`.

### Reserved Decisions

The trigger switch is the stop control. Security settings, feeds, routing and gate configuration are human-only resources. A person always decides: widening authority, deletion, external publication, production updates, weakening monitoring, changing an envelope, and accepting a K or C risk. L3 and L4, when they come, stop with the trigger and collect an `EvidenceBundle` before containment unless a non-destructive step must come first.

## Agent Identity And Enforcement Boundaries

In v0.1.0 the investigation and review agents, channel-triggered Turns and remote MCP clients become their own principals (E7, E9, E10, E11). Other internal agents and external channel people follow after v0.1.0.

| Mechanism | Enforced at | Same for every harness and Sandbox backend |
| --- | --- | --- |
| E1–E6, E11, pause | Core authentication, trigger, Pending Requests, attention, channel adapter, admission, dispatch | Yes |
| E7, E10 | The Kernel at Core operations and publication | Yes; the agent loop holds no check |
| E9, influence bit, hold | Policy interception at Core operations, the MCP Gateway and Vault delivery; Core context assembly and write boundaries; the model call through the LLM Gateway | Yes; Provider-neutral through bridged routes |
| Task egress | AEP, compiled per backend | OpenShell enforces it; other backends qualify or are refused |

Ordinary work gains no step: the gate fires only at risk points in influenced contexts, the hold only when a definition changes, and the trigger reads records after the fact.

## Proposed Design

**Retained changes** (one register row each, with the identifier declarations above as their format): the trigger state family (switch, state, cursor, outbox with per-recipient acknowledgement, occurrences, triage revisions, Thread generations, last report, feeds); the security-notice attention source; `automation`; the event list, including the pairing events; the security identifiers; the pause setting; the hold state; the Item ingress fact; the influence bit on AgentSessions, sessionless context records, Knowledge and Memory; the gate settings; the context attributes in PermissionDecision summaries; the Token principal binding and the `IntegrationIdentity` owner. Gate output stays transient.

## Current Implementation Projection

Nothing here is implemented; Background and the E11 inventory record the current state. The gate seam exists but its participant runs the default model in a loop (`policy/agent-gate-provider.ts`).

## Alternatives Considered

- A model on the alert path.
- Duplicating owners: a new Turn category, event store, notifier or hooks.
- Tool allowlists, a second authorization layer.
- A gate that may allow (widens authority) or runs on every operation (slows all work).
- Gating only Turns with external Items in view: summaries and compaction launder influence.
- Per-Item lineage now: precise but costly.
- An OpenAI-only gate; free-form permission matrices; capability-token formats; reusing shutdown admission for the pause.

## Consequences

- Administrators get a daily report, occasional requests and link-only channel messages; an item stays in each administrator's queue until they answer it.
- Most tool-using contexts become influenced, so their risk points wait for a decision request, or a person without a route; the gate's budget and cache carry the cost.
- Shared Threads may get narrower answers than private ones.
- E1, E7, E9, E10 and E11 change authentication, attribution or effect release, so acceptance evidence follows them.

## Rollout / Migration Plan

| Owner | Amendment |
| --- | --- |
| [Security](../core/security.md) | New core charter (promoted with this spec) |
| [Policy](../core/policy.md), [Policy model](20260629-openkit_policy_model.md) | Agent principal for agent-for-User work (`:119`); self-initiated rule; investigation and review principals; trigger grants; restrict-only gates without shadow (`:263`); intersection; context attributes; presets; audience rule for agent replies; default statements; full-diff `policy.write` ceiling |
| [Mediation](../core/mediation.md), [LLM Gateway](20260526-llm_gateway_responses_api.md) | Distinct, truthful roles (`:60`); the `decision` category and capability; the OpenAI adapter; the structured-output bridge |
| [Identity](../core/identity.md), [Remote auth](20260704-remote_auth_credential_bootstrap.md) | One principal per Token; user-owned `IntegrationIdentity`; MCP client issue; credential list; cascade; limiter; trusted hops; revoked signal |
| [Protocol](../core/protocol.md) | Core-local trigger workflow; the Item ingress fact; the influence bit as a fact on sessionless agent Turns |
| [AgentSession](../core/agent-session.md), [AgentSession continuity](20260704-agent_session_continuity.md) | The influence bit on AgentSessions, inherited by replacement and successor reuse |
| [Context compaction](20260902-agent_runtime_context_compaction.md) | The bit survives rolling context, retained summaries and compaction |
| [Knowledge](../core/knowledge.md), [Knowledge store](20260703-knowledge_store_implementation.md), [personal Memory](20260909-personal_memory_and_knowledge_learning.md) | Carried influence bit: encoding, validation, propagation through governed retrieval |
| [Pending Requests](20260930-pending_requests.md), [Communication](../core/communication.md) | Requester `automation`; copies stay open after the decision; a durable security notice is an attention source of its own, eligible independent of its request's state; an answer or withdrawal by a non-recipient never ends it (answer authority unchanged) |
| [Recurring Triggers](20260711-scheduler_recurring_event_triggers.md) | The closed trigger, its states, the alarm grant, the notice drain independent of detection, the identifier declarations |
| [Chat mode Assistant](20260704-chat_mode_assistant.md) (Administration entry); attention; Discord adapter | Security Thread placement and private context projection; Subject with on-behalf-of; fixed text; reminder and renotice; pairing events |
| [Audit](20260703-audit_usage_evidence_records.md), [retained format register](20261017-retained_format_register.md) | Event list, names, fields, families |
| [Bootstrap readiness](20260704-nanocore_bootstrap_readiness.md); [MCP supply](20260704-worker_mcp_tool_supply.md); Web serving | Pause; tool-definition hold; CSP |

**Defaults.** Off by default except the CSP, the hold, the ingress fact, the influence bit, the agent-principal amendment, the intersection, the audience rule, the ceiling and the credential list. The gate becomes active only after an administrator activates a route that passed the eval; until then the person fallback applies to influenced contexts.

**Migration.** No data migration. A missing ingress fact reads as "not recorded"; a context with no recorded bit counts as influenced; existing tokens are unchanged.

## Testing Strategy / Acceptance Criteria

Every case uses adversarial input and shows refusal before any effect; stateful cases also hold across a restart.

| Area | Cases |
| --- | --- |
| E1 | 429 after the threshold per account and per source; forged headers ignored without trusted hops; one record per crossing; a guessed id produces no record |
| E2, E3 | Inventory equals the SBOMs, with gaps shown; `MAL-` and KEV as K; no feed lowers a class; oversized, slow, redirected, malformed and over-paginated feeds stay bounded and marked without delaying the watch; a failure clears nothing |
| E4 | A crash at each step gives one request per row with recomputed ids, and a partial tuple becomes `recovery_required`; busy, archived and revoked-recipient cases; turning off or losing authority before a scan, and across a restart, still alarms every administrator before `off`. **Drain regression:** raise B's stop alarm → reach `off` → A withdraws B's request before delivery → restart → B still receives the notice without monitoring being re-enabled. No Provider call |
| E5 | One fixture per event and rule, including pairing; a missing field is reported as unsupported |
| E6 | A fake Discord transport receives only fixed text, including for cross-user and rebound accounts. A answers or withdraws B's copy before delivery, including across a restart, and B's notice survives and is delivered. Concurrent answers give one decision; repeated disagreement gives one `conflict` per revision; restart replay gives the same decision, conflict and ids; an old answer after `fixed` leaves `fixed`. Overdue and expired answers reopen; the reminder is created once |
| E7 | With a valid configuration delegation, an injected report drives dispatch, prepare and recover; each is denied before effect and audited with the on-behalf-of chain; a security Task has no egress |
| E9 | The eval passes on native OpenAI and one bridged route. A stub `allow` never turns `deny` or `require_approval` into `allow`; every failure kind escalates. **Two-Turn regression:** Turn 1 reads a remote MCP Tool result; compaction replaces it with a model summary; Turn 2 in the same context attempts a channel send to another person, and the gate or a person still decides. The same holds for sessionless work, a resumed or forked context, and a second session reading Knowledge written by the first. An owner-only context makes no call. A cache hit is identical and audited |
| E10 | Private material never enters a shared-Thread reply; an agent with a wider grant is held to its requester; self-initiated work outside an established trigger context is refused; an unresolved audience refuses delivery; `policy.write` refuses removing a prohibition, deactivating a required gate and a grant beyond the author's authority; an out-of-scope write is denied; no author approves their own widening |
| E11 | An MCP client token acts as its own principal within the user's authority and Token scope; revoking it or disabling the user stops it; every listed kind, including own sessions, revokes from the list |
| Pause | Refuses new agent Turns, Task starts and queued dispatch; answers, cancellation, revocation and unpause still work; survives a restart |

## Risks & Mitigations

| Risk | Mitigation |
| --- | --- |
| Alert fatigue | Classes, deduplication, bounds, digests |
| False sense of coverage | "Not covered" and "incomplete", with reasons |
| Feed outage or hostile feed | Isolation and bounds; failures clear nothing |
| The gate misses an injection | One layer among several; eval floor on the block rate |
| The sticky bit over-counts and slows work | Only risk points fire; cache; false-positive ceiling; latency budget; per-Item lineage later |
| Decision Provider sees action data | Minimal structured input with no secrets; settings state what is sent; prefer zero-retention routes |
| Sole administrator away | K reminder; L3 later; part 2 for managed instances |

## Open Questions

- None blocking.
- [Non-blocking] The engineer may adjust the v0.1.0 split, the eval thresholds, the gate budget and the timing of the Workspace-administrator scope.

## Deferred / Future Work

The following work is tracked after v0.1.0:

- [Contained response](https://github.com/lingkaix/openkit/issues/654) (#654).
- [Automated repair](https://github.com/lingkaix/openkit/issues/655) (#655).
- [Off-host audit export](https://github.com/lingkaix/openkit/issues/656) (#656).
- [Workspace security notices](https://github.com/lingkaix/openkit/issues/657) (#657).
- [Policy denial and Vault refusal signals](https://github.com/lingkaix/openkit/issues/658) (#658).
- [Containment loss notice](https://github.com/lingkaix/openkit/issues/659) (#659).
- [Spend anomaly warning](https://github.com/lingkaix/openkit/issues/660) (#660).
- [Canary credentials](https://github.com/lingkaix/openkit/issues/661) (#661).
- [Configuration posture report](https://github.com/lingkaix/openkit/issues/662) (#662).
- [Review gate expansion](https://github.com/lingkaix/openkit/issues/663) (#663).
- [Agent principals for internal agents](https://github.com/lingkaix/openkit/issues/664) (#664).
- [Per-token principals](https://github.com/lingkaix/openkit/issues/665) (#665).
- [Shared credential lifecycle store](https://github.com/lingkaix/openkit/issues/666) (#666).
- [OAuth for MCP clients](https://github.com/lingkaix/openkit/issues/667) (#667).
- [Agent-to-agent credentials](https://github.com/lingkaix/openkit/issues/668) (#668).
- [External-person identity](https://github.com/lingkaix/openkit/issues/669) (#669).
- [Group conversations](https://github.com/lingkaix/openkit/issues/670) (#670).
- [Delegation chain in audit](https://github.com/lingkaix/openkit/issues/671) (#671).
- [Per-Item content lineage](https://github.com/lingkaix/openkit/issues/672) (#672).
- [Credential checks on Knowledge and Memory writes](https://github.com/lingkaix/openkit/issues/673) (#673).
- [Administrator session controls](https://github.com/lingkaix/openkit/issues/674) (#674).
- [Workspace-administrator Policy scope](https://github.com/lingkaix/openkit/issues/675) (#675).
- [Step-up authentication](https://github.com/lingkaix/openkit/issues/676) (#676).
- [Two-factor authentication and passkeys](https://github.com/lingkaix/openkit/issues/677) (#677).
- [Per-Workspace model routes](https://github.com/lingkaix/openkit/issues/678) (#678).
- [Extension withdrawal list](https://github.com/lingkaix/openkit/issues/679) (#679).
- [Extension permission summary](https://github.com/lingkaix/openkit/issues/680) (#680).
- [MCP package identity](https://github.com/lingkaix/openkit/issues/681) (#681).
- [Isolated frames for MCP Apps](https://github.com/lingkaix/openkit/issues/682) (#682).
- [Cross-Workspace authorization suite](https://github.com/lingkaix/openkit/issues/683) (#683).
- [Egress qualification per backend](https://github.com/lingkaix/openkit/issues/684) (#684).
- [Instance pull requests from a fork](https://github.com/lingkaix/openkit/issues/685) (#685).
- [GitHub App credential kind](https://github.com/lingkaix/openkit/issues/686) (#686).
- [Offline advisory data](https://github.com/lingkaix/openkit/issues/687) (#687).
- [Automatic read-only investigation](https://github.com/lingkaix/openkit/issues/688) (#688).
- [Plain-language briefing feeds](https://github.com/lingkaix/openkit/issues/689) (#689).

Development and release deferrals are linked by [Development Security](20261109-development_security.md#deferred--future-work).

## Links

[OSV schema](https://ossf.github.io/osv-schema/) · [OSV API](https://google.github.io/osv.dev/api/) · [CISA KEV](https://www.cisa.gov/known-exploited-vulnerabilities-catalog) · [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions) · [Lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/) · [CaMeL](https://arxiv.org/abs/2503.18813)
