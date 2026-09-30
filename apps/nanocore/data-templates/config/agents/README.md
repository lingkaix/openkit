# Agent Manifest Templates

These manifests copy into authored Agent configuration at initialization. All four select `openkit/worker-runtimes:dev` and a distinct adapter: Codex 0.159.2, Pi 0.99.1, OpenCode 2.0.20, or DeepSeek 0.2.0-rc.2. Resolution carries `runtime.adapter` to AEP `control.adapter.targetRuntime`; image contents confer no authority. Existing authored configuration is never overwritten by a later template edit.

Each template declares the common tool binary paths and exactly the five copy-on-init development grants owned by [Agent Manifest And AEP Resolution](../../../../../docs/specs/20260703-agent_manifest_aep_resolution.md#built-in-development-grant-templates). No mise supply host or concrete Provider credential is added. Pi declares the dedicated SDK host executable; DeepSeek declares `dsh` and uses the default profile without an undeclared instructions reference.

Pi and DeepSeek remain disabled pending live bounded Gateway inference qualification; image packaging smoke does not grant readiness. Codex and OpenCode retain their existing readiness policy. Pi's host uses the workspace-patched 0.99.1 native MCP and tool-search closure, with no community adapter. Managed MCP and native configuration qualification remain with each adapter's owner.

Run `pnpm --filter @openkit/nanocore exec vitest run src/docker` for catalog, image-source and template checks, and `pnpm --filter @openkit/config-schema test` for schema checks. Build and smoke instructions live in [the deployment image guide](../../../../../containers/worker-runtimes/README.md). This version starts from a new data root and does not read earlier-version data under the [accepted decision](../../../../../docs/decisions/20260930-earlier_version_data_not_carried.md).
