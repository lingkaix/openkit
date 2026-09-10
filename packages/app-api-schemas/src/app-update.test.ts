import { describe, expect, it } from 'vitest';

import {
  AppUpdateHostErrorSchema,
  AppUpdateHostOutputSchema,
  AppUpdateStatusResponseSchema,
  PrepareAppUpdateRequestSchema,
  PrepareAppUpdateResponseSchema,
  StartAppUpdateRequestSchema,
} from './app-update.js';

const COMMIT = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const BOOT_ID = `boot_${REQUEST_ID}`;
const TIMESTAMP = '2026-09-10T00:00:00.000Z';

const candidateBoot = {
  acceptingProductWork: true,
  blockingReasons: [] as string[],
  bootId: BOOT_ID,
  imageId: DIGEST,
  sourceCommit: COMMIT,
};

const releaseSource = {
  appDigest: DIGEST,
  kind: 'release' as const,
  sourceCommit: COMMIT,
  tag: 'v0.1.0',
};

const succeededPredicates = {
  acceptingProductWork: true,
  helperReachable: true,
  imageMatch: true,
  nanohostReady: null,
  newBoot: true,
  noBlockingReadiness: true,
  retainedAuthRead: true,
  sourceMatch: true,
  webAssets: null,
};

describe('app update schemas', () => {
  it('pins a published release source by tag, commit, and digest', () => {
    expect(
      PrepareAppUpdateRequestSchema.parse({
        expectedCurrentImageId: DIGEST,
        source: releaseSource,
      }).source
    ).toEqual(releaseSource);
  });

  it('pins an exact-commit source without a local-build digest', () => {
    expect(
      PrepareAppUpdateRequestSchema.parse({
        expectedCurrentImageId: DIGEST,
        source: { kind: 'commit', sourceCommit: COMMIT },
      }).source
    ).toEqual({ kind: 'commit', sourceCommit: COMMIT });
  });

  it.each([
    { kind: 'release', tag: 'latest', sourceCommit: COMMIT, appDigest: DIGEST },
    { kind: 'release', tag: 'v0.1.0', sourceCommit: COMMIT.toUpperCase(), appDigest: DIGEST },
    { kind: 'release', tag: 'v0.1.0', sourceCommit: COMMIT, appDigest: 'sha256:latest' },
    { kind: 'commit', sourceCommit: COMMIT, appDigest: DIGEST },
    { kind: 'latest', sourceCommit: COMMIT },
  ])('rejects mutable or mixed source selectors: %j', (source) => {
    expect(
      PrepareAppUpdateRequestSchema.safeParse({
        expectedCurrentImageId: DIGEST,
        source,
      }).success
    ).toBe(false);
  });

  it('returns a prepared review object without executing replacement', () => {
    expect(
      PrepareAppUpdateResponseSchema.parse({
        expectedCurrentImageId: DIGEST,
        preparedAt: TIMESTAMP,
        requestId: REQUEST_ID,
        source: releaseSource,
        stage: 'prepared',
      }).stage
    ).toBe('prepared');
  });

  it('requires explicit maintenance consent and the prepared request id to start', () => {
    expect(
      StartAppUpdateRequestSchema.parse({
        maintenanceConsent: true,
        requestId: REQUEST_ID,
      }).requestId
    ).toBe(REQUEST_ID);
    expect(
      StartAppUpdateRequestSchema.safeParse({
        maintenanceConsent: false,
        requestId: REQUEST_ID,
      }).success
    ).toBe(false);
    expect(
      StartAppUpdateRequestSchema.safeParse({
        command: 'docker restart',
        maintenanceConsent: true,
        requestId: REQUEST_ID,
      }).success
    ).toBe(false);
    expect(
      StartAppUpdateRequestSchema.safeParse({
        maintenanceConsent: true,
        requestId: 'req_not_a_host_uuid',
      }).success
    ).toBe(false);
  });

  it('projects a redacted receipt and rejects secret-shaped errors', () => {
    const status = AppUpdateStatusResponseSchema.parse({
      candidateBoot: null,
      candidateImageId: null,
      completedAt: null,
      error: null,
      expectedCurrentImageId: DIGEST,
      jobId: null,
      outcome: 'prepared',
      predicates: null,
      preparedAt: TIMESTAMP,
      previousAppRestored: null,
      previousBoot: null,
      previousImageId: null,
      requestId: REQUEST_ID,
      source: releaseSource,
      stage: 'prepared',
      startedAt: null,
    });

    expect(status.stage).toBe('prepared');
    expect(status.outcome).toBe('prepared');
    expect(status.predicates).toBeNull();
    expect(
      AppUpdateStatusResponseSchema.safeParse({
        ...status,
        error: 'ssh failed with okt_should_not_leak',
      }).success
    ).toBe(false);
  });

  it('records the observed boot identity on a succeeded receipt', () => {
    const status = AppUpdateStatusResponseSchema.parse({
      candidateBoot,
      candidateImageId: DIGEST,
      completedAt: TIMESTAMP,
      error: null,
      expectedCurrentImageId: DIGEST,
      jobId: 'job_app-update.service',
      outcome: 'succeeded',
      predicates: succeededPredicates,
      preparedAt: TIMESTAMP,
      previousAppRestored: false,
      previousBoot: null,
      previousImageId: DIGEST,
      requestId: REQUEST_ID,
      source: releaseSource,
      stage: 'succeeded',
      startedAt: TIMESTAMP,
    });

    expect(status.candidateBoot?.bootId).toBe(BOOT_ID);
    expect(
      AppUpdateStatusResponseSchema.safeParse({
        ...status,
        candidateBoot: null,
      }).success
    ).toBe(false);
    expect(
      AppUpdateStatusResponseSchema.safeParse({
        ...status,
        candidateBoot: {
          acceptingProductWork: true,
          blockingReasons: [],
          imageId: DIGEST,
          sourceCommit: COMMIT,
        },
      }).success
    ).toBe(false);
    expect(
      AppUpdateStatusResponseSchema.safeParse({
        ...status,
        outcome: 'running',
        stage: 'succeeded',
      }).success
    ).toBe(false);
  });

  it('treats helper stdout as a receipt or a coded error, never both', () => {
    const status = AppUpdateStatusResponseSchema.parse({
      candidateBoot: null,
      candidateImageId: null,
      completedAt: null,
      error: null,
      expectedCurrentImageId: DIGEST,
      jobId: null,
      outcome: 'prepared',
      predicates: null,
      preparedAt: TIMESTAMP,
      previousAppRestored: null,
      previousBoot: null,
      previousImageId: null,
      requestId: REQUEST_ID,
      source: releaseSource,
      stage: 'prepared',
      startedAt: null,
    });
    const failure = AppUpdateHostErrorSchema.parse({
      error: {
        code: 'app_update_recovery_required',
        message: 'App-update receipt is missing.',
      },
    });

    expect(AppUpdateHostOutputSchema.parse(status)).toEqual(status);
    expect(AppUpdateHostOutputSchema.parse(failure)).toEqual(failure);
    expect(AppUpdateHostErrorSchema.safeParse(status).success).toBe(false);
    expect(AppUpdateStatusResponseSchema.safeParse(failure).success).toBe(false);
  });

  it('keeps predicates null before verification and requires a closed success set after', () => {
    const prepared = {
      candidateBoot: null,
      candidateImageId: null,
      completedAt: null,
      error: null,
      expectedCurrentImageId: DIGEST,
      jobId: null,
      outcome: 'prepared',
      predicates: null,
      preparedAt: TIMESTAMP,
      previousAppRestored: null,
      previousBoot: null,
      previousImageId: null,
      requestId: REQUEST_ID,
      source: releaseSource,
      stage: 'prepared',
      startedAt: null,
    };
    const succeeded = {
      candidateBoot,
      candidateImageId: DIGEST,
      completedAt: TIMESTAMP,
      error: null,
      expectedCurrentImageId: DIGEST,
      jobId: 'job_app-update.service',
      outcome: 'succeeded',
      predicates: succeededPredicates,
      preparedAt: TIMESTAMP,
      previousAppRestored: false,
      previousBoot: null,
      previousImageId: DIGEST,
      requestId: REQUEST_ID,
      source: releaseSource,
      stage: 'succeeded',
      startedAt: TIMESTAMP,
    };

    expect(AppUpdateStatusResponseSchema.parse(prepared).predicates).toBeNull();
    expect(AppUpdateStatusResponseSchema.parse(succeeded).predicates).toEqual(succeededPredicates);
    expect(
      AppUpdateStatusResponseSchema.safeParse({
        ...prepared,
        predicates: succeededPredicates,
      }).success
    ).toBe(false);
    expect(
      AppUpdateStatusResponseSchema.safeParse({
        ...succeeded,
        predicates: null,
      }).success
    ).toBe(false);
    expect(
      AppUpdateStatusResponseSchema.safeParse({
        ...succeeded,
        predicates: { ...succeededPredicates, imageMatch: false },
      }).success
    ).toBe(false);
    expect(
      AppUpdateStatusResponseSchema.safeParse({
        ...succeeded,
        predicates: { ...succeededPredicates, nanohostReady: false },
      }).success
    ).toBe(false);
    expect(
      AppUpdateStatusResponseSchema.safeParse({
        ...succeeded,
        predicates: { ...succeededPredicates, echoedSource: true },
      }).success
    ).toBe(false);
    expect(
      AppUpdateStatusResponseSchema.parse({
        ...succeeded,
        predicates: { ...succeededPredicates, nanohostReady: true, webAssets: true },
      }).predicates?.webAssets
    ).toBe(true);
  });
});
