# Findings

This record preserves execution findings and evidence; accepted Core and specifications retain design authority.

## Follow-up Index

- [ ] `AOE-FND-001` [open] A1 temporary-directory deletion exceeded the selected pathname boundary

## [open] AOE-FND-001 — A1 temporary-directory deletion exceeded the selected pathname boundary

- **Observation:** After the authorized A1 test-temporary cleanup, direct inspection found `/tmp` itself absent. The directory has since been recreated as root-owned mode 1777. The original batch's complete selected-name and dispatch evidence was overwritten by later attempts; the remaining 5360-name list does not establish why the parent directory was deleted. Newline-delimited `xargs` is unsafe for general pathnames, but its causal role in this incident is not established.
- **Impact:** Loss of the parent `/tmp` directory crossed the intended selected-path boundary. Exact additional content loss and service impact are unquantified because the full original deletion evidence is unavailable. Directory recreation does not restore deleted contents or establish application-level health. A2 was not a cleanup target; further deletions are stopped.
- **Evidence:** `temp/live-deployment/a1-cleanup/incident-20260910-tmp-removed/frozen-bytes/` retains surviving scripts and attempt output. `repair-evidence-20260910T0547Z.txt` in that incident directory verifies A1 machine identity, `/tmp` and `/var/tmp` owner/mode, and active SSH/Docker services. Claude session `473eea88-9c15-4943-b51e-b54feaef25d5` independently inspected the host and surviving pathname list.
- **Owner:** Repository Safety Kernel and `docs/change-execution.md` own the execution boundary; primary coordinates incident disposition and Cursor `live-deployment` owns bounded host inspection and recovery.
- **Next action:** Preserve surviving exact evidence, establish the remaining observable service impact and record what cannot be reconstructed. Do not rerun deletion or claim deleted contents restored; any subsequent cleanup must use an independently inspected exact pathname boundary.
