/**
 * Account generation for in-flight reads.
 * A response that started under an earlier generation is discarded.
 */
let generation = 0;

/** Generation of the account that currently owns cached reads. */
export function accountGeneration(): number {
  return generation;
}

/** Bumps the generation so earlier-account responses cannot land. */
export function advanceAccountGeneration(): number {
  generation += 1;
  return generation;
}
