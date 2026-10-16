---
type: change-plan
status: implemented
date: "2026-10-16"
branch: lane/ga
---
# Named Token Connection

## Intent Revision 1

Source: the engineer's L-GA assignment, D-GA-1. Provide explicit CLI selection of an administrator-issued named Workspace Token and a supported Skill procedure. Preserve the endpoint administrator credential and keep secrets out of arguments, output, prompts and evidence. Land this correction before the remaining administration work. This change does not authorize host operations or a live Story 4 rerun.

## Owners And Boundaries

[Remote Auth Credential Bootstrap](../../specs/20260704-remote_auth_credential_bootstrap.md) owns named storage, credential resolution and Token authority. [Agent Operator Skill](../../specs/20260910-agent_operator_skill.md) owns CLI commands, errors and delivery. The explicit selector uses the existing endpoint/name identity and storage lifecycle. NanoCore continues to decide membership, read-only scope, revocation and expiry. No durable shape, dependency, client launcher or secret export is added.

## Checkpoint

The bundled regression observed the expected invalid_usage failure before implementation. Explicit named selection now binds doctor and authenticated calls to the existing endpoint/name store. Invalid or missing selection, ambiguous environment configuration and unsupported local/bootstrap use fail before network contact. The regression checks successful selected transport, stored-byte preservation, doctor with unavailable administrator diagnostics and unchanged server denials.

`pnpm build:openkit` passed. `node --test tests/openkit-skill-interface.test.mjs tests/openkit-public-redaction.test.mjs` passed 90 tests, zero failures and skips. Biome checked the three changed JavaScript files and formatted the two source/test files. The setup attempt with an unpinned runtime failed during module collection and supplied no behavioral evidence; pinned Node 24.18.0 and pnpm 10.33.3 with frozen dependencies supplied the deciding results.

Next action: wait for the integrator's landing window, update from landed main, regenerate the CLI and document index, run repository gates and obtain exact-head independent review and full CI. No live Token, host, remote MCP client or external message was used. Story 4 still needs its separately authorized product acceptance run.
