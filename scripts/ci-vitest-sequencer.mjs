/** Balance only NanoCore's CI partitions; execution and collection share this sequencer. */
import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';

const timings = JSON.parse(readFileSync(new URL('./ci-nanocore-timings.json', import.meta.url)));
const isolatedTimelineFile = 'src/storage/thread-timeline-activity-budget.test.ts';

/** Start expensive files first, with path ties independent of discovery order. */
function longestFirst(files, duration) {
  return files.slice().sort((a, b) => {
    const cost = duration(b) - duration(a);
    return cost || (a.moduleId < b.moduleId ? -1 : a.moduleId > b.moduleId ? 1 : 0);
  });
}

/** Assign every collected specification once to the lightest measured bin, including untimed files. */
export function balanceFiles(files, count, duration) {
  const bins = Array.from({ length: count }, () => []);
  const totals = bins.map(() => 0);
  for (const file of longestFirst(files, duration)) {
    let target = 0;
    for (let index = 1; index < count; index++) if (totals[index] < totals[target]) target = index;
    bins[target].push(file);
    totals[target] += duration(file);
  }
  return bins;
}

/** Implements Vitest's sequencer interface for the single NanoCore project, not ordinary local runs. */
export default class CiVitestSequencer {
  /** Retains the runner's root and shard selector, without a separate test inventory. */
  constructor(ctx) {
    this.ctx = ctx;
  }

  /** Stale or absent measurements affect estimates only; runtime discovery remains authoritative. */
  duration(file) {
    const path = relative(this.ctx.config.root, file.moduleId).split(sep).join('/');
    return timings.files[path] ?? timings.fallbackMs;
  }

  /** Keep the timing oracle alone while collection and execution share the complete discovery union. */
  async shard(files) {
    const { index, count } = this.ctx.config.shard;
    if (count === 9) {
      const isolated = files.filter(
        (file) =>
          relative(this.ctx.config.root, file.moduleId).split(sep).join('/') ===
          isolatedTimelineFile
      );
      if (isolated.length !== 1)
        throw Error('NanoCore CI requires exactly one whole Timeline timing oracle');
      if (index === count) return isolated;
      return balanceFiles(
        files.filter((file) => file !== isolated[0]),
        count - 1,
        (file) => this.duration(file)
      )[index - 1];
    }
    return balanceFiles(files, count, (file) => this.duration(file))[index - 1];
  }

  /** Apply the measured longest-first order within each partition. */
  async sort(files) {
    return longestFirst(files, (file) => this.duration(file));
  }
}
