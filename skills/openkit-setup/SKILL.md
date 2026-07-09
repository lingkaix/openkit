---
name: openkit-setup
description: Connect an MCP-capable desktop agent app to OpenKit for normal end-user work. Use when a human wants Codex, Pi Agent, Claude CoWork, or another agent app to configure the OpenKit stdio MCP server, connect to an existing local or remote NanoCore backend, verify workspace readiness, diagnose connection or auth failures, link a confirmed workspace repository, or hand off to `openkit-loop` for Goal Mode work. Do not use for OpenKit repository development; use `openkit-setup-dev` instead.
---

# OpenKit Setup

## Use This Skill When

Use this Skill when the agent app needs to set up OpenKit as a user-facing MCP control surface over an already available NanoCore backend.

The user may have a local NanoCore instance on the same machine, a supplied remote NanoCore URL, or a deployment-specific authentication instruction.

After setup is healthy, switch to `openkit-loop` for Goal Mode, Action Center review, artifact reading, evidence handling, and bounded workspace loop coordination.

## Do Not Use This Skill For

- Developing or dogfooding the OpenKit repository. Use `openkit-setup-dev`.
- Running Goal Mode work. Use `openkit-loop` after setup.
- Installing NanoCore, supervising backend processes, executing arbitrary shell commands, reading backend internals, or bypassing deployment auth.

## Choose Backend

Ask the human or deployment which backend to use before configuring MCP.

Use a local NanoCore backend when the user wants OpenKit to run on this machine and can start or install NanoCore locally.

Use a remote NanoCore backend when the user has a server URL, workspace information, and any required deployment-provided authentication.

Remote mode is a connection path, not a permission bypass. If the deployment has no supported auth contract, report that production remote access is not configured.

## Local Backend Setup

Confirm that NanoCore is installed or otherwise available on the user's machine.

Ask the human to start NanoCore with the product-supported local startup command for their installation.

Use `http://127.0.0.1:3000` as the default local NanoCore URL unless the human provides another port.

Configure `OPENKIT_NANOCORE_URL=http://127.0.0.1:3000` for the MCP server.

## Remote Backend Setup

Ask for the NanoCore server URL, workspace id, and any deployment-provided auth instructions.

Configure `OPENKIT_NANOCORE_URL` to the supplied remote NanoCore base URL.

When the deployment provides a scoped NanoCore token, configure `OPENKIT_NANOCORE_TOKEN` with that token value.

Do not invent tokens, inspect secrets, print credential values, or add private headers unless the deployment's public instructions require them.

If remote status fails with unauthorized, forbidden, TLS, DNS, or connection errors, explain the specific failure and ask the human for the correct server or auth configuration.

## Configure Stdio MCP

Configure the desktop AI app to launch the OpenKit MCP server as a standard stdio MCP process.

For the current repository distribution, use command `pnpm`, args `["--filter", "@openkit/mcp", "start"]`, cwd set to the OpenKit workspace root that contains `mcp/`, and env containing `OPENKIT_NANOCORE_URL`.

For a future standalone distribution, use the package-provided start command instead of assuming a repository checkout.

Set `OPENKIT_WORKSPACE_ID` when the user already knows the workspace. Set `OPENKIT_THREAD_ID` only when resuming a known thread.

Do not treat MCP startup as proof that NanoCore is reachable.

## Verify Setup

Always begin with `openkit.read_status`.

Explain NanoCore reachability, workspace id, repository readiness, active Goal Mode state, and Action Center counts before taking action.

If a repository is needed, call `openkit.link_repository` only after the human confirms the path or repository resource.

After linking, call `openkit.read_repositories` and continue only when diagnostics are ready.

Do not create goals, run worker steps, read artifacts for review, or resolve Action Center items from this setup Skill. Switch to `openkit-loop` when the human wants to start a user work loop.

## Handoff

When status, optional repository diagnostics, and MCP startup are healthy, tell the human that setup is complete and recommend `openkit-loop` for bounded workspace work.

Do not hide failing checks.

Real provider-quota work must be opt-in and explicitly approved by the human.
