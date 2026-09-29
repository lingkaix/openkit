# Agent Manifest Templates

These repository-owned manifests are copied into a deployment's authored Agent configuration during initialization. They select runtime images, logical-model preferences, profiles and explicit sandbox requirements; they do not choose private upstream Provider routes or contain credentials. Existing deployment configuration remains authored data and is not overwritten by changing a template.

`pi.agent.jsonc` pins Pi `0.85.1`, prefers the Gateway logical `grok` model, and requires `trusted-worker-inference-relay`. Its adapter uses today's session-continuity mode: one fresh process per Turn against the exact retained JSONL selected by the current AgentSession's private handle, consuming the admitted AEP model parameters through an ephemeral native descriptor and the distinct worker inference token. Direct upstream credentials, native Skills, and MCP remain outside this route. That exact-handle continuity is not the accepted resident SDK host. Keep its readiness disabled until live bounded inference proof satisfies the [Pi Worker Adapter owner](../../../../../docs/specs/20260716-pi_worker_adapter.md). Image smoke is a separate content check and grants no dispatch readiness.

The accepted design requires worker runtimes to speak MCP and makes the AgentSession the resident binding, so neither stays outside this route ([Worker MCP Tool Supply](../../../../../docs/specs/20260704-worker_mcp_tool_supply.md), [AgentSession](../../../../../docs/core/agent-session.md)). Direct upstream credentials stay outside the route.

Run `node --test containers/worker-pi/smoke.test.mjs` from the repository root for the focused Pi manifest and image-source checks. The image guide at `containers/worker-pi/README.md` describes its separate build and smoke commands.

The accepted design removes the `worker-pi` leaf; [Worker Execution Environment Images](../../../../../docs/specs/20260721-worker_execution_environment_images.md) owns the image, and this version starts from a new data root and does not read earlier-version data ([Earlier-Version Data And Sessions Are Not Carried](../../../../../docs/decisions/20260930-earlier_version_data_not_carried.md)).
