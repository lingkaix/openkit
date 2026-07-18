# Setup and Connection

Load this reference for initial connection, endpoint changes, authentication setup, credential storage, bootstrap, `doctor`, or connection diagnosis.

## Establish the connection

1. Confirm that the host can load this Skill, execute its bundled script, provide Node.js 24, and protect local credentials and environment state.
2. Resolve `scripts/openkit` relative to the installed Skill directory.
3. Set `OPENKIT_NANOCORE_URL` only when the process must use an explicit local or remote NanoCore endpoint.
4. Run `scripts/openkit doctor` before invoking product operations.
5. Report endpoint reachability, authentication availability, NanoCore readiness, and contract compatibility without exposing sensitive values.

Use the same public interface for local and remote NanoCore endpoints. Do not assume that a local endpoint authorizes unauthenticated access; follow the result returned by `doctor`.

## Handle credentials safely

Store persistent bearer credentials through the endpoint-keyed credential operation and supported local credential store. Use `OPENKIT_NANOCORE_TOKEN` only as an explicit ephemeral automation override.

Pass bootstrap codes, tokens, and other secret inputs through stdin or a platform credential mechanism. Never pass them as arguments, print them, quote them in conversation, or persist them in artifacts, evidence, knowledge, or logs.

Use `ops search` with terms such as `credential`, `bootstrap`, or `connection`, then use `ops describe` before calling the selected operation. Generic access-token creation and rotation are intentionally unavailable when no safe named credential destination exists.

Treat a secure-storage preflight failure as a setup blocker. If bootstrap consumption reports that credential storage failed, do not ask the CLI to reveal the consumed token; report the typed failure and require a new explicit setup decision.

## Diagnose failures

Interpret CLI exit statuses consistently:

- Treat `0` as a successful command envelope.
- Treat `2` as a local usage, input, or schema error and correct the request locally.
- Treat `3` as a connection or authentication failure and rerun `doctor` after correcting endpoint or credential state.
- Treat `4` as a typed NanoCore rejection and follow its redacted error code and details.
- Treat `1` as an unexpected CLI failure and preserve only redacted diagnostics.

When `doctor` reports a capability or contract incompatibility, update the complete OpenKit Skill artifact or connect to a matching NanoCore deployment. Do not add a compatibility alias or bypass the check.
