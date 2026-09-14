---
type: change-plan
status: verified
started: 2026-09-14
branch: feat/52-cli-token-create-rotate-safe-dest
---
# Named CLI Token Delivery

## Intent Epoch 1

Source: the engineer's request and https://github.com/lingkaix/openkit/issues/52. Implement generic access-token create/rotate only with an explicit safe named local credential destination that cannot overwrite the endpoint administration credential. Preserve secret-free output, existing token list/revoke, and the App API deployment-admin boundary. Do not change the personal admin-token operations shipped in #51, reopen #17, merge, or deploy A2. Commit tests before implementation with hooks enabled, push, open one PR fixing #52, and comment on #52.

## Owners And Method

The engineer explicitly selected the named local store extension and same-slice spec update. `docs/specs/20260704-remote_auth_credential_bootstrap.md` owns credential storage; `docs/specs/20260713-openkit_agent_skill_interface.md` owns the catalog, client projection and redaction. Extend the existing store with a separate service/application and fallback directory, reuse shared App API schemas and public client methods, and retain NanoCore as Token and authorization authority. Issuance and local delivery remain separate effect domains without automatic recovery or replay.

The deciding checks use existing Node test and CLI subprocess helpers. Prior expectations come from #52 and the two owners: invalid destinations cause no issuance, named writes preserve exact endpoint credential bytes, only the selected named slot changes, and captured output contains no fixture secrets. Platform command doubles prove namespace/argv mapping, real temporary encrypted files prove local persistence/isolation, and bundled fetch fixtures prove client transport and envelope projection. Existing NanoCore auth tests supply server-owned authorization evidence; these tests do not claim a live OS-keychain or deployed-server proof.

## Working Checkpoint

The first five new regressions failed on missing named methods and missing catalog operations, then passed after implementation. Commit `14da33b` records those tests before production changes. A further link redirection regression failed before the named filesystem check; commit `f5e338e` records it and process-level storage failure coverage. Named fallback now rejects links and replaces encrypted files atomically. Source and bundled interface tests passed 34/34; the existing auth-token and deployment-admin suites passed 15/15. Core-client dependency typechecks passed for all five selected packages under Node 24.18.0 and pnpm 10.33.3.

Independent reviewer inspection reproduced stale named reads after keychain outages and fallback replacement, including reappearance after deletion. A dedicated regression failed before correction and was committed as `20f782c`. The same named slot file now persists backend selection; missing selection never discovers orphan keychain entries. This is named-only local delivery authority, not a new server record, automatic repair or endpoint behavior change. Re-review found no remaining actionable findings and independently reproduced correct replacement, deletion and restart behavior.

## Final Verification

- `node --test tests/openkit-skill-interface.test.mjs`: 36 passed, 0 failed, 0 skipped, including malformed selection and keychain-selection publication failure.
- `pnpm --filter @openkit/nanocore exec vitest run src/auth-token-app.test.ts src/deployment-admin-routes.test.ts --reporter=tap-flat`: 15 passed.
- `pnpm --filter @openkit/core-client... build` and `pnpm --filter @openkit/core-client... typecheck`: all five selected packages passed.
- `pnpm bundle:openkit` passed. The reviewer independently rebuilt the executable and confirmed byte identity, SHA-256 `cbc8acb71164df7c519b43c4369ce088dde10056b612ba48f5ca9493c293c767`.
- Focused Biome, Node syntax, spec lifecycle, documentation model/index, interface reachability, test-governance, and `git diff --check` passed. One existing unused-parameter warning in the untouched Vault listing handler was confirmed at baseline `611baa1` and remains outside this slice.

Named raw evidence is retained uncommitted under `temp/changes/202609141400000000-cli_named_token_delivery/`. Evidence is bounded to command doubles, real temporary encrypted storage, bundled subprocesses and existing server-owned auth tests; no live OS-keychain or deployed-server proof is claimed. Local slot deletion may leave an unreachable keychain orphan when cleanup is unavailable, and failed backend-selection publication has an unknown local outcome. Both limits are explicit in the owner and do not authorize automatic repair.

Implementation and independent review are complete. Next action is the authorized branch push, one PR fixing #52 and the issue comment; publication will be recorded after observing the GitHub result. Merge and A2 deployment remain excluded.
