---
status: Accepted
date: "2026-10-01"
decider: Engineer
---
# Pi Extension Support Boundary

## Decision

The engineer approved applying the [OpenCode plugin support boundary](20261001-opencode_plugin_support_boundary.md) to Pi Extensions: 「同意，Pi 也用同样的边界」 ("Agreed, Pi uses the same boundary too"). Pi native settings, packages and Extensions load from the admitted agent directory and Workspace with native precedence, alongside the host-supplied Extensions. A statically detectable native setting, or declared setup that replaces a protected binding or a host-supplied Extension, still fails setup before provider work without editing the user's files. Later Extension execution that rewrites a provider request, for example through `before_provider_request`, `before_provider_headers` or `registerProvider` after the setup checks, is user code inside the Sandbox and outside supported supply. OpenKit promises neither detection nor prevention of that later execution, and no outcome in which the managed route served the provider request. The bounded codemode checks of the [Pi codemode support boundary](20261001-pi_codemode_support_boundary.md) stay as they are. Sandbox egress, Gateway authority, both session loopback credentials, and every managed, credential, cancellation and lifecycle protection remain unchanged. This design approval does not establish implementation acceptance or release readiness.

## Reason

The engineer's priority, recorded with the OpenCode decision, is platform data continuity, product logic and stability rather than runtime-level guarantees, because the worker runtimes evolve fast and their integration may be redone. Agent analysis, approved: Pi 0.99.1's Extension API fires `before_provider_request`, whose handler may replace the payload, and `before_provider_headers`, whose handler may change or delete headers, on every provider call after the host assembles it. `registerProvider` may override a provider's base URL from any event callback. The host registers the managed model and runtime key at open and again only when a model change is pending, so a setup check cannot wrap later callbacks. Extensions share the Pi host process and its permissions, so they are user code inside the Sandbox, not a security boundary, and universal prevention would ban an in-Sandbox feature, contrary to [full permission inside the Sandbox](20260930-full_permission_inside_the_sandbox.md). A request that does reach the loopback listener stays inside the current route family, Turn, package-route and selected-server checks.

Source: the 2026-10-01 working session recorded in the agent communication redesign change record, following a Consultant report on the OpenCode question that named the same Pi surface. No Pi redirect was executed; the evidence is the pin's Extension type surface.

## Rejected Alternatives

- **Loading native configuration without Extensions.** Rejected because it contradicts native discovery under [adapters honor native configuration](20260930-adapters_honor_native_configuration.md).
- **Wrapping or re-registering the provider after every Extension event.** Rejected because another observation point does not prove the absence of later user code, the same failed method recorded for codemode, and it adds execution-enforcement machinery inside the Sandbox.
- **Waiting for a Pi release with a protected provider phase.** Rejected for now because it blocks native configuration on an upstream change with no release in view.

## Revisit When

- A Pi release offers a final protected provider-request phase or an admission-time Extension contract.
- Evidence shows that a rewritten request avoids Gateway checks, reaches an endpoint outside Sandbox egress policy, or gains another binding's authority. That would be a separate Safety Kernel defect, which fails closed.

## Affected Owners

- docs/specs/20260716-pi_worker_adapter.md
