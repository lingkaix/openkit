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

Use `ops search` with terms such as `credential`, `bootstrap`, or `connection`, then use `ops describe` before calling the selected operation. Use `token.create` or `token.rotate` only with an explicit non-reserved local `destination` name such as `automation`, described by the operation. These operations require a server-admin bearer token in server mode, store the issued secret into the named slot, and return redacted token records and storage metadata. They never replace or select the endpoint administration credential.

Treat a secure-storage preflight failure as a setup blocker. If bootstrap consumption reports that credential storage failed, do not ask the CLI to reveal the consumed token; report the typed failure and require a new explicit setup decision.

## Diagnose failures

Interpret CLI exit statuses consistently:

- Treat `0` as a successful command envelope.
- Treat `2` as a local usage, input, or schema error and correct the request locally.
- Treat `3` as a connection or authentication failure and rerun `doctor` after correcting endpoint or credential state.
- Treat `4` as a typed NanoCore rejection and follow its redacted error code and details.
- Treat `1` as an unexpected CLI failure and preserve only redacted diagnostics.

When `doctor` reports a capability or contract incompatibility, update the complete OpenKit Skill artifact or connect to a matching NanoCore deployment. Do not add a compatibility alias or bypass the check.

Named slots are distinct per endpoint and name. Names contain 1–64 lowercase letters, digits, underscores or hyphens, start with a letter, and cannot be `admin`, `endpoint`, `default`, `current` or start with the token prefix. Reusing a name replaces only that named credential. Named writes prefer a safe keychain writer and otherwise use the warned encrypted fallback. Reads honor the persisted backend selection; they never revive older credentials when a backend returns. Local slot deletion prevents rediscovery even if unavailable keychain cleanup leaves an orphan, and does not revoke the server token. Named storage does not change subsequent CLI authentication. A preflight storage failure prevents issuance. A storage failure after issuance requires token inventory inspection and a new explicit recovery decision; never ask to print the one-time secret or blindly retry.

Use `workspace.dashboard` for eligible work and counts, `thread.dashboard` for one eligible Thread, and `app.search` with `query` for product content search. These differ from `ops search`, which discovers operation metadata. Current Workspace membership is required, and administrator credentials do not reveal another user's private Threads. `thread.create` defaults to private; create formal Task/Goal work with explicit `visibility: workspace` and admitted inputs. These reads do not implement conversation sharing or private-to-shared handoff.
