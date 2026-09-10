# OpenKit Skills

OpenKit maintains two complementary packages. The [public `openkit` Skill](openkit/SKILL.md) operates running NanoCore through the bundled public CLI under [Agent Skill Interface](../docs/specs/20260713-openkit_agent_skill_interface.md). The independent [`openkit-ops` Skill](openkit-ops/SKILL.md) packages installation, configuration, upgrade, diagnosis and offline recovery guidance under [Agent Operator Skill](../docs/specs/20260910-agent_operator_skill.md).

## Public Product Interface

The public package contains its concise entrypoint, generated Agent-host metadata, bundled `scripts/openkit` executable and progressively loaded references. The CLI exposes supported public end-user and operator capabilities through operation search, description and invocation. Workflow truth, authorization, approvals and durable records remain in NanoCore. It has no arbitrary HTTP, source-editing, SSH or generic shell mode.

## Operations Interface

The operations package contains its entrypoint, directly linked canonical operator references and any bounded support scripts required by an accepted operation owner. It works from outside the source checkout and can guide recovery while NanoCore is unavailable. Procedures name required host tools and explicitly acquire source when needed. Credentials and host authority come from the user's Agent environment, not the Skill. NanoCore/Web updates and separately authorized NanoHost work remain distinct.

## Maintenance And Packaging

Keep one maintained source per topic. `docs/manual/` points to the operations package; release packaging includes each complete Skill tree and license with matching checksums. Changes to supported behavior update the affected reference in the same slice. Skill metadata and package checks do not replace a real-use proof.

Worker-side MCP and Skill supply retain their Agent Capability and catalog owners. Neither package introduces a user-facing MCP server, developer-mode product client, fleet, daemon or self-improvement harness.
