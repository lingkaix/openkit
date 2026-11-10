/** Explicit same-release fixture, independent of the implementation under test. */
export const TEST_WORKER_RELEASE_IDENTITY = Object.freeze({
  sourceCommit: 'a'.repeat(40),
  releaseTag: null,
});
