/**
 * Release-owned supply qualification, shipped with Core and the Worker adapters from the same commit. The AEP separately carries the exact admitted image digest; this table contains no digest literal. Native Skill regressions qualify each entry, and Worker reports cannot add entries or forms.
 */
export const WORKER_ADAPTER_SUPPLY_FORMS: Readonly<
  Record<string, ReadonlyArray<'skill-filesystem-copy'>>
> = Object.freeze({
  codex: Object.freeze(['skill-filesystem-copy'] as const),
  pi: Object.freeze(['skill-filesystem-copy'] as const),
  opencode: Object.freeze(['skill-filesystem-copy'] as const),
  deepseek: Object.freeze(['skill-filesystem-copy'] as const),
});
