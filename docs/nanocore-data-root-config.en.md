# NanoCore DATA_ROOT Config Guide

This guide explains the user-editable files under `DATA_ROOT/config` for NanoCore.

`DATA_ROOT` is the directory selected by `OPENKIT_DATA_ROOT`; when the environment variable is not set, NanoCore uses `openkit-nanocore-data` under the system temp directory.

NanoCore reads `DATA_ROOT/config/server.jsonc` as the only server-level config file. Removed OpenKit-specific server config filenames are not read.

## Directory Layout

```text
DATA_ROOT/
  config/
    server.jsonc
    providers/
      *.provider.jsonc
    agents/
      *.agent.jsonc
```

`server.jsonc` owns server-wide mode, sign-up policy, networking, Vault startup, provider instances, provider defaults, gateway settings, and internal endpoints.

`providers/*.provider.jsonc` defines reusable provider profiles that are merged with provider instances from `server.jsonc`.

`agents/*.agent.jsonc` defines agents that NanoCore can expose to workspaces.

All files are JSONC, so comments and trailing commas are allowed.

## server.jsonc

Minimal example:

```jsonc
{
  "schemaVersion": 1,
  "mode": "local",
  "gateway": {
    "openaiCompatible": {
      "enabled": true
    }
  }
}
```

### Top-Level Options

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `schemaVersion` | `1` | No | Config schema marker. Current supported value is `1`. |
| `mode` | `"local"` or `"server"` | No | Runtime mode. `OPENKIT_CORE_MODE` overrides this value. Missing mode defaults to `local`. |
| `server` | object | No | Public network settings. |
| `auth` | object | No | Server sign-up policy. Authentication is always enforced in server mode. |
| `vault` | object | No | Vault backend selection and encrypted-file key source. |
| `providers` | array | No | Server-owned provider instances. |
| `defaults` | object | No | Core and gateway provider/model defaults. |
| `gateway` | object | No | OpenAI-compatible gateway settings. |
| `internal` | object | No | Internal NanoCore endpoints. |

Unknown top-level keys are rejected. Add a schema field only when NanoCore has a current runtime owner for it.

### `mode`

`local` starts NanoCore for local development with the implicit user `user_local`.

`server` starts NanoCore in authenticated server mode.

Resolution order is:

1. `OPENKIT_CORE_MODE`
2. `server.jsonc` `mode`
3. `local`

### `server`

| Option | Type | Description |
| --- | --- | --- |
| `publicBaseUrl` | exact HTTP or HTTPS origin | External origin used by Better Auth. `BETTER_AUTH_URL` overrides this value. |
| `bind.host` | string | HTTP bind host. `OPENKIT_BIND_HOST` overrides this value. Local mode defaults to `127.0.0.1`; server mode defaults to `0.0.0.0`. |
| `bind.port` | integer `1..65535` | HTTP port. `PORT` overrides this value; the default is `3000`. |
| `cors.origins` | exact URL origins | Browser origins allowed to send credentialed requests. Server mode rejects every unlisted origin; local mode additionally allows loopback browser origins. `BETTER_AUTH_TRUSTED_ORIGINS` explicitly overrides this list for Better Auth only. |

### `auth`

| Option | Type | Description |
| --- | --- | --- |
| `signup.enabled` | boolean | Enables or disables email/password sign-up. |

Server mode always requires Better Auth and rejects startup unless `BETTER_AUTH_SECRET` contains at least 32 characters. Use `OPENKIT_DATA_ROOT` to select the data root; `server.jsonc` does not declare its own location or layout version.

### `vault`

| Option | Type | Description |
| --- | --- | --- |
| `localDefaultBackend` | `"os-keychain"` or `"encrypted-file"` | Local mode defaults to `os-keychain`; set `encrypted-file` only when local operation should use the server-owned encrypted store. Server mode always selects `encrypted-file`. |
| `encryptedFile.keyFilePath` | absolute path string | Optional boot key for the encrypted-file backend. The file must be a regular, non-symlink file owned by the NanoCore process user, have exact `0600` permissions, and contain exactly 32 raw bytes. |

Use a key file outside `DATA_ROOT`: production boot's general portability gate rejects `server.jsonc` when it embeds the current absolute data-root path, and an external key stays out of data-root backups and portable records. Do not store hex or base64 text in the file; NanoCore reads exactly 32 binary bytes through one no-follow file descriptor.

Generate a new key as the same operating-system user that runs NanoCore:

```bash
umask 077
node -e "require('node:fs').writeFileSync('/absolute/external/openkit-vault.key', require('node:crypto').randomBytes(32), { flag: 'wx', mode: 0o600 })"
chmod 600 /absolute/external/openkit-vault.key
```

Keep a separately protected backup of this key. Never regenerate or replace it for an existing store: losing the only correct key makes existing Vault material unrecoverable, while a wrong replacement remains locked and cannot repair the store.

```jsonc
{
  "schemaVersion": 1,
  "vault": {
    "localDefaultBackend": "encrypted-file",
    "encryptedFile": {
      "keyFilePath": "/run/secrets/openkit-vault.key"
    }
  }
}
```

At boot, a valid configured key initializes an authenticated header only when `DATA_ROOT/server/vault` is empty, or verifies the existing header before the backend becomes available. A missing, invalid, or wrong key leaves Vault locked and readiness degraded without blocking unrelated product work or exposing the key path or material. A non-empty store without a header is never initialized or repaired automatically.

### `providers`

Each entry is a configured provider instance.

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | Yes | Stable provider instance ID used by defaults, gateways, agents, and diagnostics. |
| `vendor` | string | Yes | Provider family or catalog vendor, for example `openai` or `openrouter`. |
| `kind` | `"direct"`, `"gateway"`, `"local"`, `"oauth"`, or `"custom"` | Yes | Provider routing kind. |
| `displayName` | string | Yes | Human-readable name. |
| `models` | non-empty string array | Yes | Models available through this instance. |
| `baseUrl` | URL string | No | Provider API base URL. |
| `defaultModel` | string | No | Default model for this provider instance. |
| `secretRef` | string | No | Secret reference such as `vault://provider_openai`. |
| `extraHeaders` | object | No | Extra upstream HTTP headers. |
| `extraBody` | object | No | Extra upstream request body fields. |

Provider instance entries reject inline credential fields such as `apiKey`, `token`, `secret`, and `clientSecret`. Use `secretRef` for secret material; unknown or consumer-free provider settings are rejected.

### Provider Kind Decision Guide

`kind` tells NanoCore how a provider should be treated for routing, diagnostics, gateway selection, and future UI grouping.

Use `direct` for a first-party model provider where NanoCore talks to that provider's own API endpoint directly. Typical examples are OpenAI, Google Gemini, and xAI. Choose `direct` when one provider account maps to one provider family, when model IDs are native to that provider, and when you want diagnostics to show that Core is calling the upstream provider directly.

Use `gateway` for a provider that routes to multiple upstream model families behind one OpenAI-compatible API. OpenRouter is the common example. Choose `gateway` when model IDs may include vendor prefixes such as `openai/gpt-5.1`, when the same account can access many upstream vendors, or when agents should call a single compatibility endpoint instead of many vendor-specific endpoints.

Use `local` for a model server running inside the same machine, LAN, or deployment boundary, usually without a remote API secret. Examples include Ollama, LM Studio, vLLM, llama.cpp server, or an internal OpenAI-compatible endpoint that is not an external SaaS provider. Choose `local` when availability depends on local process health, GPU/runtime setup, or local network reachability rather than an external account.

Use `oauth` for a provider whose credentials are obtained through an OAuth flow rather than a static API key. This is reserved for providers where user authorization and token refresh matter. Choose `oauth` only when NanoCore or a future auth layer owns a real OAuth connection; do not use it for plain API-key services.

Use `custom` for an operator-defined provider that does not fit one of the built-in vendor assumptions. This is the right kind for an arbitrary OpenAI-compatible endpoint, an internal company gateway, a proxy service, or a vendor that NanoCore does not yet model directly. Choose `custom` when you must provide an explicit `baseUrl` and model list yourself.

| Kind | Best for | Usually needs `baseUrl` | Usually needs `secretRef` | Common `models` format |
| --- | --- | --- | --- | --- |
| `direct` | First-party SaaS model APIs | Yes | Yes | Native provider model IDs such as `gpt-5.1` |
| `gateway` | Multi-provider routing gateways | Yes | Yes | Routed model IDs such as `openai/gpt-5.1` |
| `local` | Local or private model servers | Yes | Often no | Local model names chosen by the server |
| `oauth` | User-authorized providers | Maybe | No static API key | Provider-specific model IDs |
| `custom` | Operator-defined compatible endpoints | Yes | Usually yes | Whatever the endpoint accepts |

### Provider Placement

Put a provider in `server.jsonc` `providers` when it is core deployment policy, should be reviewed with server defaults, or is tightly coupled to `defaults.coreProviderId`, `defaults.gatewayProviderId`, or gateway allowlists.

Put a provider in `config/providers/<id>.provider.jsonc` when it is a reusable profile, a shipped template, or a provider that operators may copy, edit, enable, disable, or replace independently of the main server config.

Do not define the same provider `id` in both places. NanoCore rejects duplicate provider IDs because every runtime reference must resolve to one provider instance.

### Provider References

`defaults.coreProviderId` points to the provider NanoCore should use for its own Core-side model calls.

`defaults.gatewayProviderId` points to the provider used by the OpenAI-compatible gateway when a caller does not explicitly choose a provider.

`agents/*.agent.jsonc` `provider.ref` points to the provider an agent should use when NanoCore prepares that agent.

These IDs all reference the same merged provider registry, so a provider can live in `server.jsonc` or in `config/providers/*.provider.jsonc`.

### Secret References

Prefer `secretRef` over inline credentials. Provider credentials should use `vault://<referenceId>`, and the matching `VaultReference` must exist before the provider is usable.

Example:

```jsonc
{
  "id": "openai",
  "displayName": "OpenAI",
  "kind": "direct",
  "vendor": "openai",
  "baseUrl": "https://api.openai.com/v1",
  "models": ["gpt-5.1"],
  "defaultModel": "gpt-5.1",
  "secretRef": "vault://provider_openai"
}
```

The matching `provider_openai` vault reference must be created before using this provider.

Inline fields such as `apiKey`, `token`, `secret`, and `clientSecret` are rejected. Use `secretRef` and keep raw credential values in the vault.

### Codex ChatGPT Subscription Providers

Use `vendor: "openai_codex"` with `kind: "oauth"` for a provider instance backed by a Codex/ChatGPT subscription account slot. The provider config stores only routing metadata and a non-secret account-slot reference:

```jsonc
{
  "id": "codex-team-a",
  "displayName": "Codex Team A",
  "kind": "oauth",
  "vendor": "openai_codex",
  "models": ["openai-codex/gpt-5.6-sol"],
  "defaultModel": "openai-codex/gpt-5.6-sol",
  "extensions": {
    "openkit": {
      "codexOAuth": {
        "accountSlotId": "team_a"
      }
    }
  }
}
```

`extensions.openkit.codexOAuth.accountSlotId` is required for Codex OAuth providers and must match `^[a-z0-9][a-z0-9_-]{0,63}$`. Use `"default"` explicitly when the provider should bind to the default account slot.

Do not put Codex bearer tokens, refresh tokens, ChatGPT account ids, `auth.json` contents, authorization headers, or `codex-home` paths in `DATA_ROOT/config`.

Server-owned account slot state lives under server files:

```text
DATA_ROOT/server/files/oauth/openai-codex/accounts/<account-slot-id>/
  account.json
  codex-home/
```

`account.json` stores sanitized metadata only: schema version, slot id, display name, last status, safe account label, plan type, last update timestamp, last public error, and last login mode. `codex-home/` is passed to Codex app-server as `CODEX_HOME` for that slot, so Codex-managed `auth.json` or Keychain records remain isolated per slot.

### `defaults`

| Option | Type | Description |
| --- | --- | --- |
| `coreProviderId` | string | Provider instance used by NanoCore's own LLM tasks. |
| `coreModel` | string | Model used by NanoCore's own LLM tasks. |
| `gatewayProviderId` | string | Provider instance used by the OpenAI-compatible gateway when a request does not select one. |
| `gatewayModel` | string | Gateway default model. |

Unset provider defaults are allowed and are not boot errors.

### `gateway.openaiCompatible`

| Option | Type | Description |
| --- | --- | --- |
| `enabled` | boolean | Enables the OpenAI-compatible agent gateway. |
| `allowedProviderIds` | string array | Provider allowlist for gateway routing. |

The public gateway route is fixed at `/v1`. It uses the same authenticated actor boundary as product APIs in server mode and the implicit local actor in local mode.

## Provider Profile Files

Provider profile files live under:

```text
DATA_ROOT/config/providers/<id>.provider.jsonc
```

Example:

```jsonc
{
  "id": "openrouter",
  "displayName": "OpenRouter",
  "kind": "gateway",
  "baseUrl": "https://openrouter.ai/api/v1",
  "models": ["openai/gpt-5.1"],
  "secretRef": "vault://provider_openrouter"
}
```

Options:

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | Yes | Stable provider profile ID. Must not duplicate another provider instance/profile ID. |
| `displayName` | string | Yes | Human-readable provider name. |
| `kind` | `"direct"`, `"gateway"`, `"local"`, `"oauth"`, or `"custom"` | Yes | Provider kind. |
| `models` | non-empty string array | Yes | Supported model IDs. |
| `baseUrl` | URL string | No | Provider API base URL. |
| `defaultModel` | string | No | Default model for this profile. |
| `secretRef` | string | No | Secret reference. Provider credentials should use `vault://<referenceId>`. |
| `readiness.status` | `"ready"`, `"degraded"`, `"blocked"`, `"disabled"`, or `"unknown"` | No | Operator-authored readiness status. |
| `readiness.message` | string | No | Human-readable readiness explanation. |
| `extensions` | object | No | Provider-specific extension config. |

If an extension entry contains `"required": true` and NanoCore does not recognize it, the provider is marked `blocked` and a diagnostic is emitted.

## Agent Config Files

Agent config files live under:

```text
DATA_ROOT/config/agents/<agent-id>.agent.jsonc
```

The loader accepts one agent config format: the authored `schemaVersion: 1` shape below. Compact agent manifests are not supported user configuration.

### Agent Config Shape

Example:

```jsonc
{
  "schemaVersion": 1,
  "id": "agent_codex_host",
  "displayName": "Codex Agent",
  "mode": "local",
  "runtime": {
    "kind": "codex",
    "adapter": "codex-app-server",
    "version": "0.0.2"
  },
  "deployment": {
    "local": {
      "command": "codex",
      "args": ["app-server", "--listen", "stdio://"],
      "cwdPolicy": "workspace"
    }
  },
  "provider": {
    "ref": "openai",
    "model": "gpt-5.1"
  },
  "profiles": [
    {
      "id": "default",
      "instructionsRef": "codex",
      "skills": []
    }
  ],
  "defaultProfileId": "default",
  "skills": [],
  "workspace": {
    "root": "."
  },
  "extensions": {}
}
```

Options:

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `schemaVersion` | `1` | Yes | Authored agent config schema marker. |
| `id` | string | Yes | Stable agent ID. |
| `displayName` | string | Yes | Human-readable agent name. |
| `mode` | `"local"`, `"remote"`, or `"a2a"` | Yes | Agent deployment mode. |
| `runtime.kind` | string | Yes | Agent runtime family, such as `codex`, `opencode`, or a future real runtime. `simulator` is reserved for NanoCore internal development and test code and is rejected in user config. |
| `runtime.adapter` | string | Yes | NanoCore adapter name. |
| `runtime.version` | string | No | Runtime version marker. |
| `transport.kind` | `"stdio"`, `"http"`, `"websocket"`, or `"a2a"` | No | Advanced override for how NanoCore communicates with the agent. Leave it unset in normal config. NanoCore infers the default from `runtime.kind`, `runtime.adapter`, and `mode`, then rejects unsupported explicit overrides. |
| `deployment` | object | Yes | Deployment-specific runtime settings. |
| `provider.ref` | string | No | Provider ID from `server.jsonc` or `providers/*.provider.jsonc`. |
| `provider.model` | string | No | Model ID passed to the agent. |
| `provider.fallbacks` | array | No | Provider fallback definitions. |
| `profiles` | array | No | Agent profile entries. Each entry requires `id` and may include additional fields. |
| `skills` | array | No | Skill entries. Each entry requires `id` and may include additional fields. |
| `workspace.root` | string | No | Workspace root marker. |
| `workspace.inputs[].target` | string | No | Workspace-relative input target. Absolute paths and `..` are rejected. |
| `workspace.filesystems[].mount` | string | No | Workspace-relative mount point. Absolute paths, `..`, and overlapping targets are rejected. |
| `workspace.env` | object | No | Non-ephemeral environment values. |
| `workspace.ephemeralEnv` | object | No | Ephemeral environment values. |
| `mcp[].id` | string | No | MCP entry ID. |
| `mcp[].mode` | `"bridge.spawned"`, `"bridge.remote"`, or `"agent.local"` | No | MCP connection mode. `agent.local` entries must not declare credential references. |
| `runtimeConfig` | object | No | Runtime-specific config. |
| `resources` | object | No | Resource limits or hints. |
| `permissions` | object | No | Permission policy. |
| `sandbox` | object | No | Sandbox policy. |
| `readiness` | object | No | Readiness checks or operator state. |
| `lifecycle` | object | No | Lifecycle hooks or policy. |
| `observability` | object | No | Logging, metrics, or tracing policy. |
| `extensions` | object | No | Namespaced agent-specific extensions. |

The agent config rejects unknown top-level fields outside the schema.

### Agent Mode Decision Guide

`mode` describes where the agent runtime lives relative to NanoCore.

Use `local` when the worker service is local to the deployment. This fits a local service or local container that NanoCore reaches through a local transport.

Use `remote` when the agent runs outside the NanoCore host or container and NanoCore communicates with it over a network endpoint.

Use `a2a` when the agent is expected to speak an Agent-to-Agent style protocol. This mode is reserved by the schema and should be used only when the matching runtime and transport support exists.

### Agent Transport Decision Guide

Do not set `transport.kind` for normal agent configs. NanoCore infers the effective transport from `runtime.kind`, `runtime.adapter`, and `mode`.

Current defaults are:

| Runtime | Adapter | Mode | Inferred transport |
| --- | --- | --- | --- |
| `codex` | `codex-app-server` | `local` | `stdio` |
| `opencode` | `opencode-server` | `local` | `http` |

Set `transport.kind` only when the adapter explicitly supports more than one transport and the deployment needs a non-default one. The loader and resolver validate explicit overrides against adapter support. For example, `runtime.kind: "codex"` with `runtime.adapter: "codex-app-server"` and `transport.kind: "http"` is invalid because the current Codex app-server adapter is a stdio JSON-RPC integration.

Use `stdio` when NanoCore launches an agent process and communicates over standard input/output.

Use `http` when the agent exposes an HTTP server.

Use `websocket` when the agent requires a persistent bidirectional socket.

Use `a2a` when the agent transport is an Agent-to-Agent protocol endpoint.

`simulated` is not a user-configurable transport. It is reserved for NanoCore's internal development, test, and service self-check executor.

### Agent Provider and Model Selection

`provider.ref` selects a provider from the merged provider registry. Use the provider `id`, not the vendor name, unless those happen to be the same string.

`provider.model` selects the model passed to the agent. It should normally be present in the referenced provider's `models` array, or match a model the provider endpoint accepts.

The older compact names `providerRef` and `modelRef` are not accepted in `DATA_ROOT/config/agents/*.agent.jsonc`.

### Agent Workspace Safety

`workspace.inputs[].target` and `workspace.filesystems[].mount` are always workspace-relative. Absolute paths are rejected because agents must not receive arbitrary host filesystem access through config.

Targets containing `..` are rejected because they could escape the workspace root.

Overlapping targets are rejected because two mounts or inputs that write into the same subtree make agent behavior ambiguous.

### Agent MCP Modes

Use `bridge.spawned` when NanoCore should spawn or supervise the MCP server and expose it to the agent through the bridge.

Use `bridge.remote` when NanoCore should connect to an already running remote MCP server and expose that capability to the agent through the bridge.

Use `agent.local` when the agent itself is responsible for starting or reading its local MCP configuration. `agent.local` entries must not declare `credentialRef`, `credentialsRef`, or `secretRef`, because NanoCore should not inject secrets into an agent-local MCP entry through this path.

### Readiness Status

Use `ready` when the provider or agent is known to be available.

Use `unknown` when availability must be probed at runtime.

Use `degraded` when it can run but has a known limitation.

Use `blocked` when configuration is incomplete or an unavailable requirement prevents use.

Use `disabled` when the entry should remain visible in diagnostics but should not be selected for normal work.

### Simulator Scope

NanoCore keeps a minimal deterministic simulator implementation for internal development, automated tests, and service self-checks. It does not call a real LLM, does not execute real tasks, and is not a user-configurable agent.

Do not create a `simulator.agent.jsonc` file under `DATA_ROOT/config/agents`. The loader rejects `runtime.kind: "simulator"` in user config. Real user work should use configured agents such as Codex or OpenCode.

## Common Tasks

### Configure a Complete Local System

This example uses a local NanoCore server, an OpenAI provider for Core tasks, OpenRouter for the agent gateway, and the Codex local agent as the default agent.

`DATA_ROOT/config/server.jsonc`:

```jsonc
{
  "schemaVersion": 1,
  "mode": "local",
  "providers": [
    {
      "id": "core-openai",
      "vendor": "openai",
      "kind": "direct",
      "displayName": "OpenAI for Core",
      "baseUrl": "https://api.openai.com/v1",
      "models": ["gpt-5.1"],
      "defaultModel": "gpt-5.1",
      "secretRef": "vault://provider_core_openai"
    },
    {
      "id": "agent-openrouter",
      "vendor": "openrouter",
      "kind": "gateway",
      "displayName": "OpenRouter for Agents",
      "baseUrl": "https://openrouter.ai/api/v1",
      "models": ["openai/gpt-5.1"],
      "defaultModel": "openai/gpt-5.1",
      "secretRef": "vault://provider_agent_openrouter"
    }
  ],
  "defaults": {
    "coreProviderId": "core-openai",
    "coreModel": "gpt-5.1",
    "gatewayProviderId": "agent-openrouter",
    "gatewayModel": "openai/gpt-5.1"
  },
  "gateway": {
    "openaiCompatible": {
      "enabled": true,
      "allowedProviderIds": ["agent-openrouter"]
    }
  }
}
```

Start command:

```bash
OPENAI_API_KEY=... OPENROUTER_API_KEY=... OPENKIT_DATA_ROOT="$PWD/temp/nanocore-data" pnpm --filter @openkit/nanocore dev
```

### Configure a Local Model Server

Use `kind: "local"` when the model is served by a local or private endpoint.

`DATA_ROOT/config/providers/local-ollama.provider.jsonc`:

```jsonc
{
  "id": "local-ollama",
  "displayName": "Local Ollama",
  "kind": "local",
  "baseUrl": "http://127.0.0.1:11434/v1",
  "models": ["llama3.1"],
  "defaultModel": "llama3.1",
  "readiness": {
    "status": "unknown",
    "message": "Ollama availability is checked outside NanoCore."
  }
}
```

`DATA_ROOT/config/server.jsonc`:

```jsonc
{
  "defaults": {
    "coreProviderId": "local-ollama",
    "coreModel": "llama3.1"
  }
}
```

### Configure an Arbitrary OpenAI-Compatible Endpoint

Use `kind: "custom"` when the endpoint is OpenAI-compatible but not one of the built-in provider families.

`DATA_ROOT/config/providers/company-gateway.provider.jsonc`:

```jsonc
{
  "id": "company-gateway",
  "displayName": "Company LLM Gateway",
  "kind": "custom",
  "baseUrl": "https://llm.example.com/v1",
  "models": ["company-chat-large", "company-chat-small"],
  "defaultModel": "company-chat-large",
  "secretRef": "vault://provider_company_gateway"
}
```

Then set `defaults.coreProviderId`, `defaults.gatewayProviderId`, or an agent `provider.ref` to `company-gateway`.

Set separate Core and gateway providers:

```jsonc
{
  "defaults": {
    "coreProviderId": "openai",
    "coreModel": "gpt-5.1",
    "gatewayProviderId": "openrouter",
    "gatewayModel": "openai/gpt-5.1"
  }
}
```

Enable server mode with Better Auth:

```jsonc
{
  "mode": "server",
  "auth": {
    "signup": {
      "enabled": false
    }
  }
}
```

Add a custom OpenAI-compatible provider:

```jsonc
{
  "id": "custom-openai-compatible",
  "displayName": "Custom OpenAI-Compatible",
  "kind": "custom",
  "baseUrl": "https://llm.example.com/v1",
  "models": ["my-model"],
  "secretRef": "vault://provider_custom_openai_compatible"
}
```

Then reference it from `server.jsonc`:

```jsonc
{
  "defaults": {
    "coreProviderId": "custom-openai-compatible",
    "coreModel": "my-model"
  }
}
```

## Validation Rules

`server.jsonc` must be a JSON object and must match the NanoCore config schema.

Provider files are loaded only when the filename ends with `.provider.jsonc`.

Agent files are loaded only when the filename ends with `.agent.jsonc`.

Duplicate provider IDs across `server.jsonc` provider instances and provider profile files are rejected.

Agent workspace targets must be relative and must not contain `..`.

Agent workspace targets must not overlap.

`agent.local` MCP entries must not declare `credentialRef`, `credentialsRef`, or `secretRef`.

Keep raw secrets out of config files. Use `secretRef: "vault://<referenceId>"` and create the matching vault reference before enabling the provider.
