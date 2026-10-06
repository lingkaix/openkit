---
status: Accepted
date: "2026-10-06"
decider: Engineer
---
# Gateway Converges On Stock Pi-ai Intermediate Representation

## Decision

The engineer approved converging Gateway inference on stock pi-ai's intermediate representation (IR): NanoCore keeps public-format input mappings and output projections, and stock pi-ai owns upstream protocol adaptation. Public-format detours disappear. The engineer accepted three premises: pi-ai inference types remain in flight and persisted Gateway records keep OpenKit-owned schemas; a narrow same-protocol native channel preserves admitted semantics the IR cannot carry and refuses an incapable selected member before Provider access; and Provider-named mapping branches are reviewed so upstream adaptation stays in pi-ai. Provider-specific reasoning conversion for common providers is permitted only inside the Gateway, preferring stock pi-ai behavior; the no-provider-specific rule outside the Gateway remains.

The engineer asked whether the native premise could be realized by extending pi-ai's IR without modifying the upstream library. The research-supported realization proposed in the accompanying owner amendments is one request-local OpenKit native envelope through documented `onPayload` and, only for native output absent from stock blocks, `onProviderStreamEvent`. It uses stock thinking signatures only with their existing provider meaning and adds no properties or block variants to stock IR types. The engineer approved the concrete amendment text, including this hook realization and reasoning projections, on 2026-10-06 after independent review (“I approve this Gateway amendment”, translated from Chinese). This record supplies rationale, not design authority in place of the affected specifications.

## Reason

The engineer's 2026-10-06 ruling, translated faithfully from Chinese: “Regarding this part of the reasoning API, I agree with your design direction and recommendations. I also agree with the three premises you mentioned. But you can consider whether we can implement your second premise by extending pi-ai's IR without modifying the upstream library. Also, you mentioned that Magpie does some adaptation for specific providers such as DeepSeek. Although I previously said not to do compatibility work for particular vendors, I think that for reasoning API conversion, if the scope is limited to the Gateway, handling common providers can be considered. Of course, unlike Magpie implementing this itself, pi-ai should already have done much of this work; you can confirm that.” Source: the engineer queue's Gateway IR convergence discussion dated 2026-10-06.

The investigation found that public-format detours apply different reasoning, tool, usage and terminal projections to the same stock result. Direct input mappings and requested-format output projections remove those competing paths while preserving OpenKit's public admission and routing responsibilities. This rationale is derived from the supplied path inventory, not a separate engineer ruling on every implementation detail.

The supplied pi-ai source investigation and intercepted-adapter probes show that stock blocks already carry common readable thinking and native reasoning signatures, and stock adapters already own much common-provider reasoning request and replay behavior. Arbitrary extra IR properties and invented variants do not reliably survive normalization and serialization. Documented payload and native-event hooks support a narrow missing-semantics channel at the existing call boundary without a second transport or a dependency fork. These are bounded source and fixture observations, not live-provider qualification. Exact member feature admission remains subject to the owning contract and its acceptance evidence.

## Rejected Alternatives

- Own a universal Gateway IR like Magpie. The accepted direction uses stock pi-ai's representation and adapters rather than making NanoCore own another upstream event model and protocol stack.
- Keep public-format detours. They duplicate mapping ownership and make reasoning, tool, usage and terminal behavior depend on the intermediate public protocol; the accepted direction converges them.
- Extend stock IR with extra properties or new block variants. Research found that normalization and serializers strip or misinterpret them; type augmentation does not add a wire consumer. The proposed native envelope uses supported hooks rather than making stock's closed message union implicitly open.
- Fork, patch, vendor or monkey-patch pi-ai. The engineer requested realization without modifying the upstream library, and the adoption owner already requires a stock release. Supported hooks cover the proposed bounded channel.
- Reimplement common-provider reasoning adaptation throughout NanoCore. The exception is limited to the Gateway and prefers stock behavior. It supplies no authority for compatibility work in callers, workers or other product modules.

## Revisit When

Revisit if direct mappings and documented hooks cannot preserve an already admitted feature, if the stock signature carrier's provider meaning changes, or if source and acceptance evidence show a required capability cannot be carried without changing the dependency boundary. Such evidence calls for an owner decision, not silent stock-type extension, a public detour or a private patch. A pi-ai version upgrade remains a separate reviewed question outside this amendment.

## Affected Owners

- [Pi AI Unified LLM Backend](../specs/20260708-pi_ai_unified_llm_backend.md): direct stock-IR mappings, native channel, reasoning projections and capability-based selection.
- [LLM Gateway Responses API](../specs/20260526-llm_gateway_responses_api.md): public format capabilities, bounded feature admission and namespace projection.
- [Pi AI Provider Gateway Adoption](../specs/20260703-pi_ai_provider_gateway_adoption.md): stock dependency, in-flight inference types and supported extension boundary.
- [Capability Usage Gateway Foundation](../specs/20260704-capability_usage_gateway_foundation.md): shared usage producer without the disappearing public-payload accounting path.
- [Work Data Retention Format](../specs/20260921-work_data_retention_format.md): admitted semantic sampling boundary and retained-record continuity.
