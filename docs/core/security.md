---
status: Accepted
---
# Security Model

This document coordinates OpenKit security: the trust boundaries, the threat model, the security-specific principles, the finding concepts and the limits OpenKit accepts.

It is a charter. Each defense is defined by its owning aspect, and this document says how those defenses fit together. Cross-aspect doctrine stays in [Doctrine](doctrine.md).

This document owns:
- the OpenKit trust-boundary map and threat model;
- the security-specific principles that coordinate the owning aspects;
- `SecurityFinding`, `ResponseClass`, `ResponseLevel`, `AdvisoryFeed` and `ComponentInventory`, as concepts;
- the stated limits and trade-offs of OpenKit security.

This document does not own:
- identity records: users, memberships, Tokens, AuthSessions and actor references ([Identity](identity.md));
- authorization principals and the Subject, permission decisions, approval gates, `AssistantReadScope`, `OutputAudience` or Policy administration ([Policy](policy.md));
- operations, mediation points, gate participation or rate limits ([Mediation](mediation.md));
- secret storage or credential injection ([Vault](vault.md));
- execution isolation or egress containment ([Sandbox](sandbox.md));
- protocol records, including pending requests and Item fields ([Protocol](protocol.md));
- audit event semantics ([Evidence](evidence.md));
- concrete deadlines, thresholds, notification workflows or record formats;
- host, network or build-machine hardening, which belongs to whoever operates them.

## Purpose

OpenKit runs agents that read untrusted content, hold delegated authority, call tools and act on external systems on behalf of people. AI agents now find and weaponize vulnerabilities in hours, and an injected instruction can reach every tool an agent may use.

OpenKit has to do three things at once:
- keep agents fully capable for ordinary work;
- bound what any one actor, credential, component or piece of content can cause;
- notice and answer threats quickly, including threats to OpenKit's own components.

Security is not a separate subsystem. It is a set of properties that Identity, Policy, Mediation, Vault, Sandbox, Protocol and Evidence preserve together. This charter keeps those properties consistent and states where they stop.

## Principles

### Agent-native security

1. **Every actor is distinguishable.**
   - People, agents, automations, external MCP clients and external channel participants each have their own identity.
   - When an agent acts for a person, the evaluated principal, the actual actor, the responsible person and the on-behalf-of relationship stay distinct, as Policy and Mediation require.
   - An agent that presents a person's own credential is, for authorization, that person ([Doctrine](doctrine.md)). Giving each acting client its own identity is therefore the way to restrict and revoke it separately.

2. **No delegation widens authority.**
   - Authority passed to an agent, a child credential or a delegated Policy scope never exceeds what its source currently holds.
   - Revoking or disabling the source ends what it delegated.
   - Credential restrictions such as scope and binding remain mandatory alongside Policy. Authentication does not replace them.
   - The exact combination rule belongs to [Policy](policy.md).

3. **One authorization owner, checks at every relevant boundary.**
   - A human surface and an agent tool surface are projections of one operation ([Doctrine](doctrine.md)). Security adds no agent-only authorization path, Tool allowlist or prompt rule that duplicates Policy.
   - One operation may still need several current checks: admission, dispatch, returned-content ingress, disclosure and post-approval execution ([Mediation](mediation.md)).
   - What an agent may do is Policy configuration.
   - Every external exposure has an accountable owner and a deterministic switch at admission.

4. **Govern inputs by eligibility and effects by boundary, not reasoning.**
   - An agent may reason freely over inputs that are currently authorized for it and eligible for the destination's audience. Ineligible material is excluded before generation, not redacted afterwards ([Policy](policy.md)).
   - OpenKit does not constrain how an agent plans or reasons in order to make it safe. It governs what crosses a boundary.
   - Ordinary agent work gains no step that it would not need without security. Additional checks sit where risk is concentrated.

5. **Content never grants authority.**
   - Messages, documents, tool results, Memory, Skills, Knowledge, model output and AI assessments never grant permission, approve a request or answer for a person.
   - Where an effect may have been influenced by external content, that effect passes a boundary that can only narrow it. Unknown influence counts as external.

6. **Deterministic authority, restricting models.**
   - Deterministic Policy and Core code decide authority, finding classes, deadlines, recipients and alert text.
   - A model-based participant may advise, or as a gate may block or escalate. It never produces authorization ([Mediation](mediation.md)).
   - An unresolved required gate never releases the effect. Timeouts, malformed results, unavailability and a missing route remain explicit failures that block or escalate to a person.
   - Agents may draft rules, invariants and patches. Independent review and replay tests precede their admission as deterministic enforcement.
   - Text that a participant examines, such as an outbound payload or a tool definition, stays untrusted even when it is wrapped in a structured request.

7. **Agents gate at decision points.** Checks attach to operations and decision points, not hooks on every agent step. This keeps agents fast and the checks explainable.

8. **Agents defend the system inside the same rules.**
   - OpenKit's own agents may investigate findings, explain them and propose fixes. They are injection targets like any other agent.
   - A principal that reads untrusted security material holds only read and propose authority for that work. Containment and repair need a person's decision or a separately bounded grant.
   - Detection and notification never depend on a model.
   - Autonomy follows reversibility and affected scope. Deterministic containment may restrict only the suspect under a separately bounded grant. Broader recoverable actions need a person or an explicitly approved, expiring preset. Irreversible decisions remain human.

9. **Humans hold intent and reserved decisions.**
   - People state intent, provide information and approve.
   - An agent may request, observe and explain a reserved decision. It may not make it.
   - What a person approves is what takes effect; a changed proposal needs a new decision.

### Platform principles

10. **Compute neutrality.**
    - Security guarantees are enforced outside the agent loop, at Core, Gateway, Vault, channel and Sandbox boundaries, so they hold the same way for every qualified harness, model Provider and Sandbox backend.
    - Activity inside a Sandbox does not cross Core boundaries. There the guarantee is what the Sandbox mounts, delivers and lets out.
    - A backend that cannot enforce a required guarantee is qualified out or refused for that work. It never silently degrades.

11. **Operator neutrality.** OpenKit is run by many operators. No advisory source, issue destination, model route or reporting channel is wired to one operator. Every mechanism is available to every operator for the systems they control.

12. **Proportionate and cheap.**
    - A mechanism earns its place by what breaks without it.
    - Defenses reuse existing owners before adding new engines.
    - Model participation is limited to selected risk points, with bounded cost.
    - Every defense has a budget. Exhaustion stays visible and tightens optional exposure within current authority instead of silently disabling required checks.

13. **Visible and recoverable.**
    - Security decisions and findings are durable and audited where a durable owner is available.
    - An authorized stop of monitoring records its alarm first. A loss of monitoring that is discovered later records a gap outcome.
    - Acknowledging a finding does not resolve the exposure. An exception keeps its review obligation and its expiry.
    - Authority checks fail closed, and required gates fail to block or escalation.
    - Inert deception assets make otherwise unexplained use detectable. Continuous self-attack finds failures before adversaries. Confirmed findings become replay tests and reviewed deterministic defenses.

14. **Editable defaults, scoped administration.** Security Policy ships as working defaults that administrators may change within their own scope. No author can widen authority beyond their own ([Policy](policy.md)).

15. **Active measures stay within authorized systems.** Deception and testing stay inside systems the operator owns or is explicitly authorized to test. They must not induce unauthorized access, damage or disclosure in another system.

## Trust Boundaries

| Zone | Trust | Note |
| --- | --- | --- |
| Core process and its durable storage | Trusted | The security of the deployment depends on them. |
| Administrator-installed host code and configuration | Trusted as installed | Changes to it are administrative operations. |
| Authenticated people | Trusted for their own authority only | Each Workspace is a separate tenant. |
| Agents and Workers | Untrusted for authority | They act through granted operations. Worker code runs inside a Sandbox. |
| Extensions, Skills, MCP servers and their tool definitions | Untrusted content | Even when an administrator installed them. |
| Model Providers | Trusted with what is sent to them; output untrusted | Output faces normal authorization and containment. |
| Channels, external transports and remote MCP clients | Untrusted transports | Identity comes from the verified sender or credential only. |
| Advisory feeds and imported content | Untrusted data | Bounded and parsed in isolation. |
| Third-party dependencies and images | Untrusted code | Admitted under the supply and execution owners. Provenance and advisory checks inform admission but do not prove safety. |

Secrets stay out of model context, prompts, logs and participant inputs ([Vault](vault.md)).

## Threat Model

Assets, in order of harm:
1. user and Workspace data, including private conversations and Knowledge;
2. credentials and Provider spend;
3. administrator authority;
4. outbound identities such as channel accounts and repository apps;
5. the integrity of audit records, findings and alerts.

| Threat | Owner of the main defense |
| --- | --- |
| Cross-Workspace access, identifier guessing and disclosure across tenants | Policy (deny by default, current evaluation); Protocol (scoped references) |
| Credential stuffing; stolen or leaked credentials | Identity; Mediation rate limits |
| Prompt injection that steers an agent toward data or effects | Policy; Mediation gates; exact-decision approval |
| Poisoning of Memory and Knowledge | Knowledge review; Mediation gates at writes |
| Using an agent to move data into a shared conversation | `OutputAudience` ([Policy](policy.md)) |
| Injection against the security response path | Deterministic detection and alerting; read-and-propose response principals |
| Malicious or changed extensions and tool definitions | Mediation at the Gateway; component inventory |
| Known vulnerable or malicious components in the instance | Component inventory, advisory feeds and findings |
| Hostile or broken advisory feeds | Feed bounds; feeds can only add or raise findings |
| Silencing the monitor | Alarm-first stop; gap outcomes |
| Denial of wallet | Gateway budgets |
| Compromised Worker code | Sandbox isolation, run-bound credentials, egress containment |

Out of scope for OpenKit as a product:
- the security of the host, its kernel, network and root account;
- the hosts that build and release OpenKit;
- a malicious administrator acting within their own authority. OpenKit records what they do, but cannot prevent it;
- a model Provider's retention or misuse of what it was sent.

## Defense Loop

Each step is owned by an existing aspect. This list only shows how they connect.

1. **Prevent at boundaries.**
   - Identity authenticates actors.
   - Policy decides governed operations with current facts.
   - Vault injects credentials only after a final allow.
   - Sandbox contains Worker execution.
   - Mediation holds changed tool definitions.
   - Web surfaces refuse active content they did not author.
2. **Restrict at risk points.** Mediation gate participants examine effects that external content may have influenced.
3. **Detect.**
   - Scheduled, deterministic Core tasks match the component inventory against advisory feeds.
   - The same tasks watch audit evidence for anomalies.
   - Trusted boundaries recognize inert deception assets and invoke bounded deterministic containment.
4. **Notify.** Core turns findings into pending requests and attention for the responsible administrators. External channels carry no finding details.
5. **Respond.**
   - L0 and L1 are deterministic Core work.
   - L2 runs an investigating agent under a read-and-propose grant, as existing governed agent work.
   - L3 and L4 need separately bounded grants. Suspect-only recoverable containment may run deterministically; broader actions retain their human or approved-preset boundary.
6. **Close and learn.**
   - A finding ends with a recorded disposition and its evidence.
   - The release gate refuses to ship open urgent findings that have no accepted disposition.

The same finding concepts apply to OpenKit's development, its releases and each running instance, although each may record them differently. A running instance can match its own components only because each release states what it contains and where it came from.

## Canonical Terms

`SecurityFinding` is the concept that a component, configuration or behavior of an OpenKit deployment is, or may be, exploitable. A finding has:
- an identity;
- the affected asset;
- its source: an advisory, an audit, or a report;
- an assessment: class, reachability and evidence;
- a responsible party;
- a disposition.

Unknown reachability counts as reachable, and an unrated finding is not treated as low.

The disposition is one of:
- open;
- fixed;
- mitigated;
- not affected (with its reason);
- accepted (with a decider and an expiry).

Acknowledgement is not a disposition. Each owner records findings in its existing records. The concept creates no separate ledger.

`ResponseClass` is the urgency of a finding. It is decided by code from the assessment, and it drives reminders, gates and response targets. The classes and their target times are defined by the development and runtime owners and shared by both. Known exploitation and published malicious packages are always the most urgent class. Targets are commitments to respond, not guarantees of a fix.

`ResponseLevel` is how far OpenKit itself acts on a finding:

| Level | Scope |
| --- | --- |
| `L0` | Record |
| `L1` | Notify the responsible people |
| `L2` | Investigate and propose; a person decides |
| `L3` | Contain under a bounded grant |
| `L4` | Repair under a bounded grant |

A level describes the scope of an action. It is never a permission. The acting principal still needs the grant.

`AdvisoryFeed` is a pluggable source of vulnerability records that an instance matches against its own components. A feed is untrusted data. It can add findings or raise their class, never close, lower or silence one. Its coverage is stated.

`ComponentInventory` is a deployment's observed list of the components it runs, with explicit coverage gaps. A missing entry is a visible gap, not evidence of safety. The inventory does not redefine catalogs or supply identities owned elsewhere.

## Limits And Trade-offs

OpenKit does not claim absolute security. It aims to bound the harm from any single failure, to notice quickly and to respond within the class target. [Security Program Rulings](../decisions/20261109-security_program_rulings.md) records the accepted scope and deferred protections.

| Limit | Why it is accepted | Mitigation |
| --- | --- | --- |
| A model gate is probabilistic. It misses some attacks, blocks some legitimate work and can itself be steered. | Deterministic rules alone cannot recognize injection. | It never authorizes. The route qualifies against an evaluation, and its residual error rates stay visible. Failures escalate. |
| A gate sends data to a Provider and costs time and money. | Risk points are few compared with ordinary steps. | Minimized, independently authorized participant input with no secrets; bounded cost; explicit failure. |
| Influence tracking is coarse. Owner input is treated as intent, so external content a person pastes may escape classification. | Precise content lineage is costly, and treating every owner message as external would gate ordinary work. | Otherwise unknown ancestry counts as external, and known influence survives summarization, compaction and reuse, in every agent context including sessionless work. Over-counting only adds checks. |
| An agent presenting a person's own credential is that person for authorization. | Core cannot tell them apart mechanically. | Separate identities for acting clients, introduced owner by owner. |
| Core cannot see inside a Sandbox. A destination allowlist does not inspect every outgoing payload. | Inspecting in-box actions would tie OpenKit to one harness and cost agent capability. | Run-bound credentials; restricted mounts and egress; backends are qualified. |
| A tool-definition hold catches changed interfaces, not changed behavior behind the same interface. | Behavior cannot be verified statically. | Extension identity, digests and review of new versions. |
| Audience bounds make agents say less in shared conversations. | Leaking one member's data into a room is worse. | People can ask in a private conversation. |
| Matching is only as good as the feeds and the inventory. Counting unknown reachability as reachable adds noise. | Missing a known exploited flaw is worse than noise. | Stated coverage gaps; reasoned `not affected` dispositions. |
| Advisory and audit scans are periodic. | Continuous scanning costs too much for most deployments. | Exploitation signals run more often; exact decoy trips invoke bounded containment immediately. |
| A decoy can be touched by legitimate work. | Deception provides a cheap signal but does not prove compromise. | Qualify ordinary-work fixtures; recover service through reviewed fresh admission; record false positives. |
| A sudden crash, a storage failure or a credential expiring naturally can stop monitoring before it raises an alarm. | No process can raise an alarm about its own sudden loss. | Gap outcomes on recovery; alarm-first only for authorized stops. |
| A single-administrator deployment has no separation of duties. | Small teams are a primary audience. | Audit and alarm-first stop still apply. |
| A malicious administrator, a compromised host or a compromised Provider is not prevented. | They sit outside the product boundary. | Audit; operator hardening; per-route Provider choice. |

Deliberate trade-offs:
- **Capability over lockdown.** OpenKit picks boundaries that leave agents able to work, and accepts some residual risk inside them.
- **Defaults and presets over free-form rules.** They are easier to get right, at the cost of some expressiveness.
- **Online checks over self-contained tokens.** Core checks credentials on each request and keeps attenuation in Policy. The cost is that Core must be reachable.
- **Restricting models over model judgment.** Models may stop actions but never authorize them, so some automation waits for a person.

## Invariants

- Delegations, child credentials and delegated Policy scopes MUST NOT widen authority beyond their source's current authority. Credential restrictions MUST remain enforced.
- Content, Memory, Skills, Knowledge, model output and AI assessments MUST NOT grant permission, approve a request or answer for a person.
- Material outside the destination's `OutputAudience` MUST be excluded before generation.
- A model-based participant MUST NOT produce authorization, and an unresolved required gate MUST NOT release the effect.
- Finding classes, deadlines, recipients and alert text MUST be decided by code.
- A principal that reads untrusted security material MUST NOT hold effect or egress grants for that work.
- Autonomous containment MUST remain recoverable and confined to the suspect under a separately bounded grant.
- Every external exposure MUST have an owner and an admission-enforced switch.
- Exhausted required defenses MUST fail closed with a visible outcome.
- Active measures MUST stay within explicitly authorized systems and MUST NOT induce unauthorized access, damage or disclosure.
- An authorized stop of monitoring MUST record its alarm before detection stops.
- An advisory feed MUST NOT close, lower or silence a finding.
- Exploitable finding details MUST NOT be sent to a public destination.
- A required security guarantee MUST be enforced outside the agent loop. A runtime backend that cannot provide it MUST be qualified out or refused for that work.

## Relationships To Other Core Aspects

- [Doctrine](doctrine.md): agent-native operations and the human-decision boundary that security relies on.
- [Identity](identity.md): actors, Tokens and AuthSessions, the unified inbound credential rules, and the mapping of channel participants.
- [Policy](policy.md): the Subject and the on-behalf-of combination, decisions, approval gates, `AssistantReadScope` and `OutputAudience`, and scoped administration.
- [Mediation](mediation.md): checks at each crossing, gate and advice participants, failure handling and rate limits.
- [Vault](vault.md): secrets kept out of models and logs; injection after a final allow.
- [Sandbox](sandbox.md): isolation, egress containment and backend qualification.
- [Protocol](protocol.md): pending requests, scoped references and Item facts that record where content entered.
- [Evidence](evidence.md): audit events, including security events.
- [Work Model](work-model.md): Task and Goal work used by investigating agents.

## Abstract Realization Notes

- A gate participant may reach its model through a Gateway request category for decisions. One Provider's native decision interface is an example, not a requirement.
- Advisory feeds may include public vulnerability databases, known-exploited catalogs and plain-language briefing services. None is required.
- External channel participants map to principals through the channel's verified sender identity. They receive no Token.
