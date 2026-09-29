# Agent Manifest Templates

These repository-owned manifests are copied into a deployment's authored Agent configuration during initialization. They select runtime images, logical-model preferences, profiles and explicit sandbox requirements; they do not choose private upstream Provider routes or contain credentials. Existing deployment configuration remains authored data and is not overwritten by changing a template.

`pi.agent.jsonc` pins Pi `0.85.1`, prefers the Gateway logical `grok` model, and requires `trusted-worker-inference-relay`. Its bounded adapter consumes the admitted AEP model parameters through an ephemeral native descriptor and the distinct worker inference token; direct upstream credentials, native Skills, MCP and session continuity remain outside this route. Keep its readiness disabled until live bounded inference proof satisfies the [Pi Worker Adapter owner](../../../../../docs/specs/20260716-pi_worker_adapter.md). Image smoke is a separate content check and grants no dispatch readiness.

Run `node --test containers/worker-pi/smoke.test.mjs` from the repository root for the focused Pi manifest and image-source checks. The image guide at `containers/worker-pi/README.md` describes its separate build and smoke commands.
