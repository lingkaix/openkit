---
status: Accepted
---

# NanoCore DATA_ROOT Configuration

This manual describes the authored JSONC configuration loaded by NanoCore from `OPENKIT_DATA_ROOT`. JSONC comments and trailing commas are accepted, unknown fields are rejected unless a schema explicitly declares an `extensions` map, and removed file or field names have no compatibility reader.

## Scope Model

OpenKit configuration has three composition scopes.

| Scope | Role | Canonical files |
| --- | --- | --- |
| Server | Supplies deployment resources, catalogs, and defaults available to Workspaces | `config/server.jsonc`, `config/model-catalog.jsonc`, `config/gateway.jsonc`, `config/internal-role-profiles.jsonc`, `config/providers/*.provider.jsonc`, `config/agents/*.agent.jsonc` |
| Workspace | Composes shared resources and defaults for one collaborative Workspace | `workspaces/<workspaceId>/config/workspace.jsonc`, `workspaces/<workspaceId>/config/data-sources.jsonc` |
| User | Stores lightweight personal preferences inside Workspaces | `users/<userId>/config/user.jsonc` |

Server supply is not a blanket restriction on Workspace composition. A Workspace may select, extend, or override Server-supplied Agent resources through its binding, and a User may select their own preference from the composed Workspace surface. Resolution priority is explicit request or Orchestrator choice, then User preference, then Workspace configuration, then Server fallback.

## Directory Layout

```text
DATA_ROOT/
  config/
    server.jsonc
    gateway.jsonc
    model-catalog.jsonc
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

### Auto-allow host push on a trusted Workspace

As a deployment administrator, inspect `repository.list` and obtain the exact trusted Workspace ID. Preserve the existing `server.jsonc` fields and add this policy entry, substituting that ID for `ws_trusted`:

```jsonc
"policy": {
  "workspaceApprovalModes": {
    "ws_trusted": { "repo.push": "auto_allow" }
  }
}
```

Validate through Settings Configuration or the public configuration operations, save, and restart the App using the deployment's existing restart procedure. This deployment-owned setting is not part of Workspace export/import. Omitted Workspaces and actions remain `require_human_approval`; unsupported actions and mode names are rejected. Set the entry to `require_human_approval` or remove it and restart to restore human approval for new requests. Existing grants and pending requests retain their original mode and target.

Enroll the GitHub credential with `vault.secret-create` using secret stdin, create a host-push grant with `vault.grant-create`, and bind the returned grant ID through `repository.set-default` as `git.vaultGrantRef`. Keep the existing repository settings and explicitly configure the intended `allowedPushTargets`; protected branches require the literal target, not just a matching wildcard. Keep `requireReviewLinkage` and protected patterns intact. Host App API / ops pushes receive a host-session linkage exemption so dogfood operators do not need to flip `requireReviewLinkage` off; worker-selected `openkit-repository` publication still requires review linkage when enabled. See the public Skill's [Vault host-push recipe](../../openkit/references/administration.md#store-a-github-token-for-approved-host-push) for credential handling.

Use `repository.push-request-approval` with a fresh request ID, running Turn, exact repository, source ref, target branch, and commit IDs. In automatic mode it returns `approval.status: granted`, `approval.id`, `approvalItemId`, and `policyDecisionId`; no `approval.respond` is needed. Invoke `repository.push-execute` with a different fresh request ID and that `approval.id` as `approvalRequestId`. Verify the returned push record and inspect `permission.workspace-list` and `audit.workspace-list` for the decision and audit. The policy request itself never pushes. In human mode, use `attention.list` and `approval.respond` or Web Action Center, then execute only after the request reads `granted`.

Replay the same request ID and input to inspect an existing request. If receipt or interrupted-attempt evidence is incomplete, inspect it before requesting fresh target authority; do not retry Git directly. Automatic mode keeps Vault grants, current membership, target rules, review linkage, imported-authority refusal, and host-only credential injection in force.

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
| `modelMetadata` | Optional map keyed by those exact IDs, using models.dev fields; effective `limit.context` is required from the pinned catalog or this declaration. |
| `defaultModel` | Optional private default for this Provider. |
| `secretRef` | Optional `vault://<referenceId>` credential reference. |
| `readiness` | Optional `ready`, `degraded`, `blocked`, `disabled`, or `unknown` projection. |
| `extensions` | Typed OpenKit extensions plus open vendor namespaces. |

Every configured model needs a known positive `limit.context`. For an uncatalogued model, author `modelMetadata: { "example/model": { "limit": { "context": 131072 } } }` alongside that exact `models` entry; this is a format example, not a claim about a real Provider. Other metadata is optional: `reasoning`, `tool_call`, `attachment`, `temperature`, `family`, `modalities.input/output`, `limit.output` and `cost.input/output/cache_read/cache_write`. Prices use USD per million tokens. Declared leaves override catalog values, including false and zero; omitted leaves inherit. An authored price applies at every request length, overriding that rate in any stock long-context tier while other tier rates remain inherited; custom tier thresholds or surcharges are not supported. Missing optional pricing does not block inference and must not create a false USD estimate.

Provider IDs, upstream model IDs, routes, and credential references are private control-plane data. Workers and product model selectors receive logical model IDs from `gateway.jsonc` instead.

Supported OpenAI Codex and xAI subscription profiles use `kind: "oauth"`, omit `baseUrl` and `secretRef`, and bind an account slot through `extensions.openkit.subscriptionAccount.accountSlotId`. See [Provider Subscription Accounts](https://github.com/lingkaix/openkit/blob/main/docs/specs/20260721-provider_subscription_accounts.md).

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

The owning design is [NanoCore Configuration and Identity Contract](https://github.com/lingkaix/openkit/blob/main/docs/specs/20260628-nanocore_config_identity_contract.md), and the implementation plan is [Composable Agent Runtime Configuration](https://github.com/lingkaix/openkit/blob/main/docs/changes/202608302326560001-composable_agent_runtime_configuration/plan.md).

## Model Not In models.dev

A deployment admin can register metadata in `DATA_ROOT/config/model-catalog.jsonc` without changing the vendored snapshot or NanoCore code. Open Settings → Configuration, select `model-catalog.jsonc`, and use its generic JSONC editor and schema reference. Startup seeds an empty file when absent. An authorized host operator may also create the file directly; the generic runtime-config API accepts `POST /api/admin/config/file` with `id: "model-catalog.jsonc"`, `kind: "model-catalog"` and source `content` when the file does not yet exist. Reads and writes require deployment-admin authority, such as a server-admin Token or a session with an active admin Token.

For example, with a Provider whose `vendor` is `openai`, add the exact native model ID under that vendor:

```jsonc
{
  "schemaVersion": 1,
  "providers": {
    "openai": {
      "models": {
        "operator-confirmed-model": {
          // Illustrative values: replace with limits verified for your actual model.
          // Reasoning effort notes belong in comments; there is no effort-enum field.
          "limit": { "context": 256000, "output": 8192 },
          "reasoning": true,
          "tool_call": true,
          "modalities": { "input": ["text"], "output": ["text"] },
          "cost": { "input": 1, "output": 2, "cache_read": 0.1, "cache_write": 1 }
        }
      }
    }
  }
}
```

The outer key is exactly the profile's `vendor`, or its `id` when `vendor` is absent. Model keys must exactly match the profile's native IDs; no alias or namespace stripping occurs during extension lookup. For the shipped Codex subscription template using `vendor: "openai_codex"` and `models: ["openai-codex/operator-confirmed-model"]`, use `openai_codex` as the outer key and the prefixed model ID as the inner key. A profile authored with vendor `openai-codex` instead needs that exact outer key; extension lookup does not normalize the two spellings. Preserve the profile's existing account-slot binding. Codex subscription effective context is capped at 256,000 tokens even if an extension or profile declares more; smaller declared limits stay smaller.

1. Save the catalog metadata, then add the same native ID to the intended Provider's `models` array. No profile `modelMetadata` patch is needed unless that profile needs a more specific override. Existing entries may remain alongside the new model.
2. In `gateway.jsonc`, add or select a logical model whose route names that Provider's `id` and exact `providerModel`. Set its required compaction threshold so threshold plus output reserve fits the effective context; for the illustrative limits above, 200,000 plus 8,192 fits 256,000.
3. Validate the composed configuration, save with the editor's current revision, and use the existing runtime reload workflow. Catalog and Provider edits are restart-required: safe reload reports pending restart and preserves active Provider metadata; strict reload refuses changes requiring restart. Restart NanoCore through the normal authorized operations procedure, then select the logical model.

Precedence is vendored snapshot → extension catalog → profile `modelMetadata`, leaf by leaf. Explicit `false`, zero costs and empty modality arrays override inherited values; omitted leaves inherit, and arrays replace. Costs are optional USD-per-million-token hints, not invoices. `family` is optional; a logical model without a known family can have only one route. The schema rejects unknown fields, invalid limits and negative costs. An unused catalog entry does not expose a model, grant credentials, or add a route.

Invalid composed configuration leaves the last-known-good runtime snapshot active. Correct it and validate again; stale revisions require rereading before writing. Removing a profile overlay restores extension inheritance; removing an extension restores snapshot inheritance after validation and restart. If removal leaves a listed model without known context, fix its declaration or remove its Provider/Gateway references before applying. No models.dev snapshot bytes are edited by these steps.
