---
status: Accepted
date: "2026-10-20"
decider: Engineer
---
# Compute And Harness Neutrality

## Decision

NanoCore is neutral to compute substrate and agent-harness location. NanoCore integrates resource and agent platforms directly. NanoHost is one first-party resource platform, a peer of external platforms, and never a mandatory intermediary. [Architecture](../core/architecture.md) owns this boundary.

Loop placement and tool-execution placement are independent axes. NanoCore's own agents MUST keep their loop in Core and dispatch only tool commands to execution targets. NanoHost Workers run their CLI loop inside the Sandbox. An external loop with an OpenKit-owned executor remains externally owned; executor ownership does not make it a Core-owned loop.

OpenKit retains the authority, Knowledge, BWM, MCP, and Skills plane. Governance applies at each integration boundary. Each integration declares its actual capabilities and limitations. Policy uses those declarations to select permitted platforms for a Workspace and refuses placement when required constraints cannot be met.

Core retains non-negotiable scheduling and management authority over agents. Core decides admission, placement, start, stop, cancellation, budgets, and deadlines. External platforms are executors scheduled by Core, never the scheduler.

OpenKit's ownership of user data is the more important non-negotiable. Adapters must bring user files, work products, retrievable conversation and process records, and Knowledge into OpenKit storage. Core is the system of record for retrieval, addition, removal, and management; provider copies are caches or external dependencies. Core refuses a platform for any work whose required user data it cannot return.

The accepted compromise covers only provider-internal execution details, such as in-loop Policy hooks and internal traces, never user data. Each integration must declare these gaps; OpenKit records capture gaps, preserves truthful unknown outcomes, and refuses placement with unsupported required constraints. OpenKit must never claim coverage it lacks.

The first integration targets are the OpenAI Agents API, E2B, and Cloudflare Agents. The OpenAI Agents API target includes both the hosted platform and use of that standard API by self-hosted equivalents.

OpenKit borrows the resource structure and naming of external standards, including E2B-style placement and Agents-API-style sessions. OpenKit's specifications define record meanings, what receipts prove, and sufficient cleanup evidence; external standards do not define these semantics. Adapters stay thin and replaceable. Compatibility is a pinned, tested subset, not a promise to follow an external API's evolution.

Design and neutrality validation precede the v0.1.0 freeze. Platform integrations follow the freeze. Current retained records keep their NanoHost meanings, including existing image identity and native-reference meanings. External forms come later as additive representations; this decision does not reinterpret existing data or introduce schema or code changes.

## Reason

The engineer's direction on 2026-10-20 is to provide additional stable options for serious work when compute becomes scarce at scale. External platforms also test whether NanoCore's authority and work model remain independent of the execution platform. Users must keep the same Knowledge, BWM, MCP, and Skills working model when placement changes.

The retained-data boundary must be clear before the freeze. Explicit current meanings prevent later integrations from treating a NanoHost image or local native reference as evidence about an external harness.

## Rejected Alternatives

- Require external platforms to pass through NanoHost. This makes one resource platform mandatory and places neutrality below the intended NanoCore boundary.
- Treat NanoHost capabilities as universal guarantees. This could admit work on a platform that cannot satisfy its governing constraints.
- Reinterpret current records or introduce external formats before their integrations. Preserve current meanings now; add representations when the integration requires them.

## Revisit When

An integration demonstrates that the accepted boundary cannot preserve required authority, work semantics, or retained-data meaning. A capability difference alone requires an honest declaration and placement decision, not a claim of unsupported coverage.

## Affected Owners

- [Product Vision](../product-vision.md)
- [Architecture](../core/architecture.md)
- [Runtime Model](../core/runtime-model.md)
- [AgentSession](../core/agent-session.md)
- [Agent Environment Package](../specs/20260616-agent_environment_package.md)
- [AgentSession Continuity](../specs/20260704-agent_session_continuity.md)
- [Work Data Retention Format](../specs/20260921-work_data_retention_format.md)
