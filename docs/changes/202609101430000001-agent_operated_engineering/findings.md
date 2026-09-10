# Findings

This record preserves execution findings and evidence; accepted Core and specifications retain design authority.

## Follow-up Index

- [x] `AOE-FND-001` [closed] A1 temporary-directory deletion exceeded the selected pathname boundary

## [closed] AOE-FND-001 — A1 temporary-directory deletion exceeded the selected pathname boundary

- **Observation:** After the authorized A1 test-temporary cleanup, direct inspection found `/tmp` itself absent. The directory has since been recreated as root-owned mode 1777. The original batch's complete selected-name and dispatch evidence was overwritten by later attempts; the remaining 5360-name list does not establish why the parent directory was deleted. Newline-delimited `xargs` is unsafe for general pathnames, but its causal role in this incident is not established.
- **Impact:** Loss of the parent `/tmp` directory crossed the intended selected-path boundary. Exact additional content loss and service impact are unquantified because the full original deletion evidence is unavailable. Directory recreation does not restore deleted contents or establish application-level health. A2 was not a cleanup target; further recursive deletion remains stopped.
- **Evidence:** `temp/live-deployment/a1-cleanup/incident-20260910-tmp-removed/frozen-bytes/` retains surviving scripts and attempt output. `repair-evidence-20260910T0547Z.txt` in that incident directory verifies A1 machine identity, `/tmp` and `/var/tmp` owner/mode, and active SSH/Docker services. Claude session `473eea88-9c15-4943-b51e-b54feaef25d5` independently inspected the host and surviving pathname list.
- **Owner:** Repository Safety Kernel and `docs/change-execution.md` own the execution boundary; primary coordinates incident disposition and Cursor `live-deployment` owns bounded host inspection and recovery.
- **Next action:** Preserve surviving exact evidence, establish the remaining observable service impact and record what cannot be reconstructed. Do not rerun deletion or claim deleted contents restored; any subsequent cleanup must use an independently inspected exact pathname boundary. The finding transitioned from open to closed on 2026-09-10 after independent residual inspection, exact nonrecursive removal of the obsolete disabled user unit, and Auditor acceptance of historical disposition; no further causal reconstruction or deleted-content restoration is claimed.
- **Closing verdict:** Closed as a historical incident disposition within the engineer-authorized expendable A1 test-data cleanup. The original deletion remains defective and its cause and exact content loss remain unknown. Restored directory and service invariants, absence of the selected test objects and removal of the obsolete restarting unit settle the concrete remaining obligations; this is not full-host application-health certification.
- **Closure evidence:** `temp/live-tester/a1-residual-read/REPORT.md` verifies identity, directory modes, selected-object absence and retained service observations. `temp/live-tester/a1-residual-read/20260910T062814Z-remove-user-openkit-nanocore-unit.out.txt` records the exact nonrecursive removals, user daemon-reload, not-found/inactive unit, zero subsequent restarts and active SSH/Docker. Independent `engineering_intent_audit` accepts this bounded disposition while retaining unknown cause and unquantified loss.
