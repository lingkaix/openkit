---
type: change-plan
status: in-progress
---
# Knowledge Manager Result Tool

## Intent Revision 1

The coordinator reported a real-provider failure on 2026-10-17: the Knowledge Manager returned Markdown, but query completion parsed bare JSON and exposed an HTTP 500. Maintenance returned text without an accepted notebook submission. Use the existing Tool schema boundary for final results, allow at most one bounded output repair response, and return a typed query refusal with the retained work references. Keep existing result fields and retained shapes.

## Intent Revision 2

The coordinator assigned the main CI Knowledge latency repair on 2026-10-17. Diagnose and fix the actual cause, retain the result repair in one head, independently review the new delta, run a priority bounded KM/retrieval gate and express-land with `--repair`. Timeout increases alone are not a fix. L-CH subsequently landed the smoke stdin repair and one-job container compilation; this branch drops its local smoke change and merges that main normally.

## Owner And Criterion Map

[Knowledge Manager](../../specs/20260704-knowledge_manager_internal_agent_runtime.md#query-and-maintenance-execution) owns role output admission. The shared internal loop owns Tool schema validation; the existing Gateway, compaction provider and role profile own model selection, usage and finite budgets. Notebook publication remains with the existing fixed-base editor and publisher.

| Criterion | Production seam | Proof |
| --- | --- | --- |
| Output uses the schema-validated result Tool | KM runner and query/maintenance assembly | Actual fake-transport run, retained completed result Tool and schema rejection |
| One repair response shares original budgets | KM Provider closure and existing compaction closure | Markdown then correct result, permanent Markdown refusal and repeated call-id refusal |
| Failed query returns a typed refusal with retained work | Query failure boundary and existing operation error projection | HTTP 422 knowledge_query_failed, exact retained failed Turn, failed asking call and no delivered answer |
| Maintenance repair repeats no notebook effect | Existing editor outcome plus terminal result Tool | Real operation/runtime no-change submission, Markdown repair, one submission and unchanged published revision |

## Working Checkpoint

The two lowest-sufficient regressions reproduced the original JSON parse failure. Implementation and tests are prepared on lane/ak-km-result-tool. No new Item kind, field, store, registry, scheduler or status family is added. The private result Tool is not a public operation. The coordinator released exactly the KM prompt section and Quick Chat final-response fake as a SCOPE-004 exception; the prepared patch is applied without other edits in those files. Independent source review approved head 3079b615. Its complete ten-file gate passed 117 of 119 cases; the two failures were the predecessor HTTP 500 expectation and a 30-second test timeout in the real Git maintenance integration. The test-only correction asserts the accepted typed refusal and redaction, and gives that integration the existing 120-second role budget. It changes no production fuse or behavioral assertion. Complete failed-file suites are rerun under Express item 8; the eight unchanged passing files carry forward. Final exact-head source review and execution qualification remain required. No real-provider acceptance or new deployment is claimed.

## Latency Repair Evidence

A single real citations test with only the Provider transport fake executed 3,894 Git commands before the fix, taking 23.77 seconds locally; about 16 seconds was synchronous Git time. Repeated nested full-source checks, including complete Git page/proof reads, were product overhead, not model latency. The same source-level checks now occur at the effect boundary rather than repeatedly inside trace checks; overview/citation reads are batched by their existing fixed source revision. No authority cache or new retained state is added. A regression requires revocation during source assembly to prevent summary dispatch. The second probe executed 1,950 Git commands; complete-suite after times and exact gate evidence remain in the lane checkpoint. Existing query and parity test limits remain unchanged in this repair. Main CI before times were 36.5 seconds, 60.8 seconds and 135 seconds for the citations, one-term and member-parity cases.
