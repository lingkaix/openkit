---
status: Accepted
date: "2026-10-01"
decider: Engineer
---
# OpenCode Plugin Support Boundary

## Decision

OpenCode native plugins load from the admitted home and Workspace with native precedence, alongside the required host plugin. A native setting, or a plugin declaration that OpenKit can detect before work, that would replace a protected binding still fails before provider work without editing the user's files. The protected bindings are the model and Gateway route, the exact OpenKit-managed MCP projection, the capability credentials, the exact session, and the host plugin and control bindings. Plugin code that changes a protected binding while it runs is outside supported supply. One example is an `http.request` hook registered after the host plugin that redirects a provider request. OpenKit has no comprehensive prevention or closed-outcome guarantee for it. Sandbox egress, Gateway authority, and every managed, credential, cancellation and lifecycle protection remain unchanged. This design approval does not establish implementation acceptance or release readiness.

## Reason

The engineer approved the coordinator's recommendation on 2026-10-01, translated from Chinese: "Agreed, authorized; we do not need to be that strict." The engineer added the priority behind it, again in translation. The worker runtimes are external and evolving fast, and later the runtime integration, or even NanoHost as a whole, may be redone, refactored or retired, for example by moving worker dispatch and scheduling to another platform. The current first goal is to run the whole flow, express the product concept completely, and let users start working on the platform. What must hold is that the platform loses no data and records none wrongly, that users can keep using it, and that its function, product logic and stability as a user workbench and control plane are assured.

Agent analysis, approved: at OpenCode `2.0.20` a plugin's hooks run in registration order, and the hook registry has no final protected phase, no registration veto, and no public way to inspect hooks. A startup check loses to a hook registered later during `context`. An executable probe with synthetic loopback providers showed a project plugin redirecting every provider request after the host plugin had applied its route. Plugins share the OpenCode server process and its permissions, so they are user code inside the Sandbox, not a security boundary. Universal prevention would ban an in-Sandbox feature, contrary to [full permission inside the Sandbox](20260930-full_permission_inside_the_sandbox.md). The structure is the one the engineer settled for Pi in the [Pi codemode support boundary](20261001-pi_codemode_support_boundary.md).

Source: the 2026-10-01 working session recorded in the agent communication redesign change record. Builder evidence is retained uncommitted under `temp/research/20261001-opencode-native/`.

## Rejected Alternatives

- **Loading native configuration without plugins.** Rejected because it contradicts native discovery under [adapters honor native configuration](20260930-adapters_honor_native_configuration.md) and needs a configuration filter that no owner requires.
- **An enforcing request wrapper or custom transport.** Rejected because it adds an execution-enforcement mechanism inside the Sandbox, with no accepted owner, and cannot stop direct library use by plugin code.
- **Waiting for a pin with a protected hook phase.** Rejected for now because it blocks native configuration on an upstream change with no release in view.

## Revisit When

- An OpenCode release offers a final protected request phase or an admission-time hook contract.
- Evidence shows that a redirected request avoids Gateway checks, reaches an endpoint outside Sandbox egress policy, or gains another binding's authority. That would be a separate Safety Kernel defect, which fails closed.

## Affected Owners

- docs/specs/20260716-opencode_worker_adapter.md
