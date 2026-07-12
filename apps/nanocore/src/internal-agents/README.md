# Internal Agents

This directory owns NanoCore's application-internal agents, bounded LLM loop, schema-validated runner, hooks, delegation, redaction, and worker coordination.

## Boundaries

- Keep internal agent definitions, registry, Quick Chat behavior, loop limits, hooks, delegation payloads, and coordinator selection here.
- Configured product and worker agents belong to `../agents/`; governed worker execution and recovery belong to `../runtime/`.
- Consume LLM dispatch and resolved provider configuration without creating another provider registry or secret-resolution path.
- Keep provider-native payloads and raw failures private, validate structured outputs, and redact diagnostics before product projection.
- Public HTTP route ownership remains with the cohesive root route modules that invoke this subsystem.

## Verification

Run the focused registry, runner, loop, hooks, delegation, event, Quick Chat, and worker-coordinator tests affected by the change, followed by the package gates in the [NanoCore source guide](../README.md).
