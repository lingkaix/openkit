---
status: Accepted
---

# NanoCore DATA_ROOT Configuration

This manual describes the authored JSONC configuration loaded by NanoCore from `OPENKIT_DATA_ROOT`. JSONC comments and trailing commas are accepted, unknown fields are rejected unless a schema explicitly declares an `extensions` map, and removed file or field names have no compatibility reader.

## Scope Model

OpenKit configuration has three composition scopes.

| Scope | Role | Canonical files |
| --- | --- | --- |
| Server | Supplies deployment resources, catalogs, and defaults available to Workspaces | `config/server.jsonc`, `config/gateway.jsonc`, `config/internal-role-profiles.jsonc`, `config/providers/*.provider.jsonc`, `config/agents/*.agent.jsonc` |
| Workspace | Composes shared resources and defaults for one collaborative Workspace | `workspaces/<workspaceId>/config/workspace.jsonc`, `workspaces/<workspaceId>/config/data-sources.jsonc` |
| User | Stores lightweight personal preferences inside Workspaces | `users/<userId>/config/user.jsonc` |

Server supply is not a blanket restriction on Workspace composition. A Workspace may select, extend, or override Server-supplied Agent resources through its binding, and a User may select their own preference from the composed Workspace surface. Resolution priority is explicit request or Orchestrator choice, then User preference, then Workspace configuration, then Server fallback.

## Directory Layout

```text
DATA_ROOT/
  config/
    server.jsonc
    gateway.jsonc
    internal-role-profiles.jsonc
    providers/
      *.provider.jsonc
    agents/
      *.agent.jsonc
  users/
    <userId>/
      config/
        user.jsonc
  workspaces/
    <workspaceId>/
      workspace-record.json
      config/
        workspace.jsonc
        data-sources.jsonc
```

`workspace-record.json` is a system-written record, not user configuration. It stores only Workspace identity, owner relationship, lifecycle, revision, and timestamps. Editable `name` and `defaultAgentId` live only in `workspace.jsonc`.

## `config/server.jsonc`

`server.jsonc` owns deployment settings and the last-resort default Agent. It does not contain Provider definitions, Gateway model routes, internal-role model defaults, or Workspace and User preferences.

```jsonc
{
  "schemaVersion": 1,
  "mode": "server",
  "defaults": {
    "defaultAgentId": "codex"
  },
  "server": {
    "bind": { "host": "0.0.0.0", "port": 3000 },
    "publicBaseUrl": "https://openkit.example.com",
    "cors": { "origins": ["https://openkit.example.com"] }
  },
  "auth": {
    "signup": { "enabled": false }
  },
  "vault": {
    "encryptedFile": { "keyFilePath": "/run/secrets/openkit-vault.key" }
  }
}
```

| Field | Purpose |
| --- | --- |
| `schemaVersion` | Schema marker; the current value is `1`. |
| `mode` | `local` or `server`; `OPENKIT_CORE_MODE` overrides it. |
| `defaults.defaultAgentId` | Server fallback used only when no explicit, User, or Workspace Agent choice exists. |
| `server.bind` | App listener host and port; `OPENKIT_BIND_HOST` and `PORT` override them. |
| `server.publicBaseUrl` | Exact public origin used by authentication; `BETTER_AUTH_URL` overrides it. |
| `server.cors.origins` | Exact browser origins allowed to send credentialed requests. |
| `auth.signup.enabled` | Email/password sign-up policy. |
| `vault.encryptedFile.keyFilePath` | Absolute path to the exact 32-byte `0600` Vault key file. |
| `nanohost` | Optional private NanoHost HTTP/2 identity, bind, rendezvous, credential reference, and two file-backed rotation slots. |

Server mode requires a `BETTER_AUTH_SECRET` of at least 32 characters. The encrypted Vault store lives under `DATA_ROOT/server/vault/`, while its key file should live outside `DATA_ROOT` and must never be regenerated for an existing store.

## `config/providers/*.provider.jsonc`

Each Provider file declares one Server-supplied Provider profile. `server.jsonc.providers` is invalid, and defining the same Provider `id` in more than one Provider file rejects every duplicate instance from the runtime registry.

```jsonc
{
  "id": "openai-primary",
  "displayName": "OpenAI Primary",
  "kind": "direct",
  "vendor": "openai",
  "baseUrl": "https://api.openai.com/v1",
  "models": ["gpt-5.1"],
  "defaultModel": "gpt-5.1",
  "secretRef": "vault://provider_openai_primary"
}
```

| Field | Purpose |
| --- | --- |
| `id` | Stable private Provider profile ID. |
| `displayName` | Operator-facing label. |
| `kind` | `direct`, `gateway`, `local`, `oauth`, or `custom`. |
| `vendor` | Optional Provider family used by adapters and subscription routing. |
| `baseUrl` | Optional API endpoint without URL credentials. |
| `models` | Non-empty list of private upstream model IDs. |
| `defaultModel` | Optional private default for this Provider. |
| `secretRef` | Optional `vault://<referenceId>` credential reference. |
| `readiness` | Optional `ready`, `degraded`, `blocked`, `disabled`, or `unknown` projection. |
| `extensions` | Typed OpenKit extensions plus open vendor namespaces. |

Provider IDs, upstream model IDs, routes, and credential references are private control-plane data. Workers and product model selectors receive logical model IDs from `gateway.jsonc` instead.

Supported OpenAI Codex and xAI subscription profiles use `kind: "oauth"`, omit `baseUrl` and `secretRef`, and bind an account slot through `extensions.openkit.subscriptionAccount.accountSlotId`. See [Provider Subscription Accounts](../specs/20260721-provider_subscription_accounts.md).

## `config/gateway.jsonc`

The Gateway maps stable logical model IDs to ordered private Provider routes. A worker requests a logical model; the Gateway selects its current route without exposing Provider or upstream model identity.

```jsonc
{
  "schemaVersion": 1,
  "enabled": true,
  "defaultLogicalModelId": "general",
  "logicalModels": [
    {
      "id": "general",
      "displayName": "General",
      "routes": [
        {
          "id": "general-primary",
          "providerProfileId": "openai-primary",
          "providerModel": "gpt-5.1"
        }
      ]
    }
  ],
  "requiredFeatures": []
}
```

`defaultLogicalModelId` is the final model fallback after an explicit request, User preference, Workspace preference, Agent preference, or internal-role preference fails to choose one. Route order is accepted configuration for deterministic fallback today; future load balancing, quota rollover, and same-family account switching can be added under `extensions` without changing worker-visible IDs.

## `config/internal-role-profiles.jsonc`

This Server catalog configures NanoCore roles such as Assistant, Goal Orchestrator, Knowledge Manager, and future internal roles without placing model choices in `server.jsonc`.

```jsonc
{
  "schemaVersion": 1,
  "defaultLogicalModelId": "general",
  "profiles": [
    {
      "id": "assistant-default",
      "roleId": "assistant",
      "preferredLogicalModelId": "general",
      "compatibleLogicalModelIds": ["general"],
      "requiredLogicalModelCapabilities": []
    }
  ]
}
```

A profile declares only model-selection preferences currently consumed by the internal-role resolver. Workspace and User files may choose a profile or logical model for a role; they do not redefine the Server profile catalog. Prompt, Tool, context-limit, fuse, and fallback-profile fields are not accepted until a runtime owner consumes them.

## `config/agents/*.agent.jsonc`

Each Agent Manifest declares one reusable Worker Agent and its Harness configuration. Multiple Agent Manifests may be materialized as multiple compatible Harness Instances in one Sandbox; each active AgentSession still belongs to exactly one Thread.

```jsonc
{
  "schemaVersion": 1,
  "id": "codex",
  "displayName": "Codex",
  "defaultProfileId": "default",
  "runtime": {
    "kind": "codex",
    "adapter": "codex",
    "version": "1",
    "image": {
      "kind": "reference",
      "ref": "ghcr.io/example/openkit-codex:latest",
      "pullPolicy": "if-not-present"
    },
    "binaries": [
      { "id": "codex", "path": "/usr/local/bin/codex" }
    ]
  },
  "models": {
    "preferredLogicalModelId": "general",
    "allowedLogicalModelIds": "all"
  },
  "profiles": [
    {
      "id": "default",
      "preferredLogicalModelId": "general",
      "skills": [],
      "mcp": []
    }
  ],
  "skills": [],
  "mcp": [],
  "sandbox": {
    "credentialDeclarations": [
      {
        "id": "github_token",
        "requirementId": "github-token",
        "purpose": "GitHub repository access",
        "required": true,
        "visibility": "runtime-env",
        "targetEnvVarName": "GITHUB_TOKEN"
      }
    ],
    "filesystem": [],
    "network": []
  },
  "requiredFeatures": []
}
```

`runtime.image` is either a published image reference or a bounded build declaration. `runtime.binaries` declares available executable paths. `models.preferredLogicalModelId` is the Agent default, while `allowedLogicalModelIds` is either a non-empty list or `all`. Profiles may refine instructions, model preference and admission, Skills, and MCP entries. Sandbox configuration declares backend requirements, credential declarations, filesystem grants, and network grants.

A direct credential declaration with `vaultGrantId` is Server-specific and therefore must reference a Server-scoped grant. A reusable manifest should instead declare `requirementId`; each Workspace binds that requirement to its own Workspace-scoped VaultGrant.

## `workspaces/<workspaceId>/config/workspace.jsonc`

The Workspace file owns shared editable composition.

```jsonc
{
  "schemaVersion": 1,
  "workspace": {
    "name": "Product",
    "defaultAgentId": "codex",
    "agents": [
      {
        "agentId": "codex",
        "profileId": "default",
        "preferredLogicalModelId": "general",
        "allowedLogicalModelIds": ["general"],
        "credentialBindings": [
          {
            "requirementId": "github-token",
            "vaultGrantId": "grant_product_github"
          }
        ],
        "skills": [],
        "mcp": []
      }
    ],
    "internalRoles": [
      {
        "roleId": "assistant",
        "profileId": "assistant-default",
        "preferredLogicalModelId": "general"
      }
    ],
    "roots": []
  }
}
```

`workspace.name` is required. `workspace.defaultAgentId` is the shared default for warm Sandbox supply and task launch when no explicit or User choice exists; `null` explicitly declines a Workspace default so Server fallback may apply. An Agent binding may select a profile, override model preference and admission, add Skills and MCP entries, extend sandbox declarations, and bind reusable credential requirements. Workspace sandbox extensions may declare only reusable requirements, never a direct concrete grant.

Workspace roots are relative `host-dir` declarations with `read-only` or `read-write` access. `createIfMissing` is valid only for a read-write root. Repository inspection configuration is under `workspace.assistant.repositoryInspection`.

## `users/<userId>/config/user.jsonc`

User configuration stores personal preferences and never modifies shared Workspace state.

```jsonc
{
  "schemaVersion": 1,
  "workspaces": [
    {
      "workspaceId": "ws_product",
      "agentId": "codex",
      "profileId": "default",
      "logicalModelId": "general",
      "internalRoles": [
        {
          "roleId": "assistant",
          "profileId": "assistant-default",
          "logicalModelId": "general"
        }
      ]
    }
  ]
}
```

These values win over Workspace and Server defaults for the current User but lose to an explicit request or Orchestrator choice. User configuration cannot publish Provider routes, shared Agent extensions, Vault grants, or Workspace policy.

## Credential Requirements and Vault Scope

The same Agent Manifest can be used by many Workspaces with different accounts and permissions. A manifest declares a stable `requirementId`, and each Workspace Agent binding maps it to that Workspace's `vaultGrantId`. A required missing binding fails Agent setup; an optional missing binding is omitted. The worker sees only the configured target such as an environment variable, file, or Provider attachment and does not see the Workspace's routing decision.

Secret material never belongs in JSONC. Vault references, grants, injection plans, receipts, and use records remain Core control-plane records. A plan is written before attempted resolution, `VaultUse` records resolution success or failure, backend-private sinks receive material, and a receipt is written only after the sink completes successfully.

## Reload Behavior

Runtime config reload validates a complete next snapshot and publishes it only when valid. New requests use the new snapshot; existing turns are not interrupted. Gateway route changes take effect without restarting workers because workers address logical model IDs. Policy and replacement secret values follow their backend's natural live behavior. When a newly added credential requires a process restart, the Sandbox Integration terminates the process after its current turn and resumes the same Thread in a replacement AgentSession.

## Validation and Editing

The Settings configuration surface can list, read, validate, create, and revision-protect supported files. `server.jsonc` may be updated but is not created through the file endpoint. Validation checks both the individual schema and the composed runtime snapshot, including missing references, duplicate IDs, and invalid logical-model bindings. The last-known-good runtime snapshot remains active when a reload candidate is invalid.

The owning design is [NanoCore Configuration and Identity Contract](../specs/20260628-nanocore_config_identity_contract.md), and the implementation plan is [Composable Agent Runtime Configuration](../changes/202608302326560001-composable_agent_runtime_configuration/plan.md).
