---
type: change-plan
status: implemented
date: "2026-10-16"
branch: lane/ga-p22-combined
---
# Shared MCP Web administration

## Intent Revision 1

Complete the P22 configuration journey over the existing Server catalog and restricted MCP Vault contracts. The accepted [Web product-surface specification](../../specs/20260628-web_product_surface_projection.md#shared-mcp-configuration-projection) owns this projection; [MCP catalog management](../../specs/20260907-mcp_catalog_management.md) owns lifecycle, scope and revisions. No store, credential mechanism, runtime effect, preview or general recovery feature is added. The native/CLI feature is an independent prior increment. Vault material/grant/request controls belong to the request-review helper; this increment owns only Server declaration/version/binding/removal and ordinary Workspace shared supply/disablement.

## Method and boundaries

Use the composed Core Client with TanStack Query and accessible existing primitives. Preserve actual configuration, catalog and binding revisions. Changes never automatically retry; current authority denial hides cached details. Unknown result or conflict blocks later writes until explicit inspection. A conflict retains the exact editable draft. Immutable version staging does not select or enable it. Grant binding omission preserves the existing list; editing it visibly replaces that exact list. Workspace disablement is scoped to the selected Workspace, with retained local collisions explained and no false restore repair. No secret input or raw upstream error enters cache or UI. Server configuration is non-secret and does not connect upstream. The UI shows mutation acceptance and current read separately from a tool effect.

Primary writes only the isolated lane/ga-mcp-web worktree. Direct out-of-area change: the Workspace Catalog screen mounts one separate shared-supply panel; no Skill lifecycle change. Shared routes, registry and exports are minimal integration. Tests were written before their implementation; their first queued execution occurred after implementation, so no observed pre-change RED is claimed. Initial Workspace panel four cases passed: exact revision/Workspace, retained collision, unknown-result inspection without replay, current denial hides cached supply. Server tests and Web typecheck are pending in p22-web-mcp-first.log. All evidence remains external in backlog evidence/L-GA.

## Completion

Finish deciding UI states/races, typecheck and lint, update local guide/manual, merge the complete branch with git merge, then regenerate interfaces as needed, integrate main, obtain exact-head independent review and full CI before the landing window. No deployment, real credential or vendor effect is authorized here.

The first complete Web run passed typecheck and seven UI cases after correcting unsupported multiline TextField props and a closed schema-policy setter. The following state run passed nine cases, Web typecheck and Web lint (eight warnings, one informational finding; zero errors) in `p22-web-mcp-states.log`. Additional immutable version and removal evidence remains pending.

Final native-backed configuration evidence: `p22-web-mcp-final.log` passed eleven cases, repository check, Web typecheck and production build. The added published-route and retained-Server-removal predicates passed with the complete thirteen-case rerun and Web typecheck in `p22-web-mcp-publication.log`. Independent review and full integrated CI remain required. This feature changes twelve files, one owning specification/projection across existing catalog/Web ownership, and adds one route registry row; it creates no durable entity or owner.

The Web dependency31bb4473 was merged into the shared-MCP native feature for one supported whole landing. The follow-up typed-operation dispatcher validates schema and common pasted credential shapes before mutation-cache admission; fourteen UI cases, exact public operation contract, Web typecheck and lint passed in p22-server-web-input-safe.log. A previously untracked-file lint gap exposed an array-index key after merge; use the canonical unique slot key instead. No warning or check was bypassed. Final integrated review/CI remain open.

The completed shared-MCP feature now uses the engineer-approved express path, with independent exact-head approval, whole affected-module local gates and mandatory Web e2e before landing, followed by main-push CI. Earlier full-CI instructions above record prior preparation only. Credential-bearing and malformed HTTP endpoints fail the shared browser-safe criterion before TanStack mutation admission; canonical storage and effective transport use that same owner. Final local gate and landing remain separate evidence.

## Combined main integration and gate scope

The coordinator's 2026-10-16 20:15Z direction combines the overlapping Server MCP, Web controls, bounded discovery, private deletion recovery, Equal membership and Vault Request features into one landing. Their accepted owners and behavior remain unchanged. P14 is on main at553ea24bab2c; the combined source normally joins the subsequent Goal main67153ca4. Source joins are automatic; the generated CLI conflict requires canonical regeneration. Earlier individual source approvals and focused results keep their exact named scopes.

The five outdated whole-NanoCore gates were explicitly stopped under that direction and returned143; none is a passing gate or a product failure. Their logs remain in the backlog. The new gate runs complete suites of the changed owner modules, complete changed-package suites, deterministic Native e2e, the complete owning Host suite and mandatory Web e2e. Main-push CI supplies whole-app coverage. Canonical combined preparation passed: eight prerequisite builds, actual OpenAPI generation and validation, CLI bundle, documentation model533, lifecycle and index. Exact integrated-head review, scoped gate and containing-main CI remain pending; no live vendor, deployment or release acceptance is claimed.
