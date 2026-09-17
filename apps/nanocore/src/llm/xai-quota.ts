import type { Models } from '@earendil-works/pi-ai';
import { z } from 'zod';

const XAI_USER_URL = 'https://cli-chat-proxy.grok.com/v1/user?include=subscription';
const XAI_BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';
const XAI_AUTO_TOPUP_URL = 'https://cli-chat-proxy.grok.com/v1/auto-topup-rule';
const XAI_USER_TIMEOUT_MS = 10_000;
const XAI_BILLING_TIMEOUT_MS = 15_000;
const XAI_AUTO_TOPUP_TIMEOUT_MS = 10_000;
const MAX_XAI_USAGE_BODY_BYTES = 65_536;
const XAI_TOKEN_AUTH = 'xai-grok-cli';
const XAI_CLIENT_VERSION = '1.0.12';
const XAI_CLIENT_MODE = 'headless';
const XaiRfc3339TimestampSchema = z.string().datetime({ offset: true });

/** One validated xAI credits window projected through the App API. */
interface XaiQuotaWindow {
  /** Stable OpenKit window identifier. */
  readonly id: 'included';
  /** OpenKit period label projected from a recognized provider type. */
  readonly periodType?: 'weekly' | 'monthly';
  /** Percentage of included credits that remains. */
  readonly remainingPercent?: number;
  /** Canonical period-end timestamp. */
  readonly resetsAt?: string;
  /** Canonical period-start timestamp. */
  readonly startsAt?: string;
  /** Provider-reported included-credit usage, clamped to 0..100. */
  readonly usedPercent?: number;
}

/** Supplied xAI money and shared-allowance fields. */
interface XaiQuotaBilling {
  /** Fixed USD currency for credits-config amounts. */
  readonly currency: 'USD';
  /** Additional spending cap in USD cents. */
  readonly onDemandCapCents?: number;
  /** Additional spend this period in USD cents. */
  readonly onDemandUsedCents?: number;
  /** Remaining purchased prepaid credits in USD cents. */
  readonly prepaidBalanceCents?: number;
  /** Unified weekly/monthly pool flag. */
  readonly sharedAllowance?: boolean;
}

/** Same-call xAI identity discovery projected through quota. */
interface XaiAccountDiscovery {
  /** Instant when this invocation observed the user document. */
  readonly accountObservedAt: string;
  /** Exact provider subscription tier, when discovery supplied a nonempty string. */
  readonly planType?: string;
  /** Official Build eligibility: nonempty exact case-sensitive tier other than Free. */
  readonly subscriptionActive: boolean;
}

/** Validated provider quota fields consumed by the App API route. */
export type XaiQuotaObservation =
  | (XaiAccountDiscovery & {
      readonly availability: 'available';
      readonly billing?: XaiQuotaBilling;
      readonly windows: XaiQuotaWindow[];
    })
  | (XaiAccountDiscovery & { readonly availability: 'temporarily_unavailable' });

/** Validated lazy auto-top-up fields consumed by the App API route. */
export interface XaiAutoTopupObservation {
  /** USD cents added when the rule fires. */
  readonly amountCents?: number;
  /** Successful rule observation. */
  readonly availability: 'available';
  /** Fixed USD currency for rule amounts. */
  readonly currency: 'USD';
  /** Protocol-default false when a rule object is present without enabled. */
  readonly enabled?: boolean;
  /** USD cents monthly cap. */
  readonly monthlyCapCents?: number;
  /** USD cents threshold before the spend limit. */
  readonly thresholdCents?: number;
}

/**
 * Reads one current xAI credits observation through the pair-scoped pi-ai runtime.
 *
 * @param models Pair-scoped stock Models runtime.
 * @param now Optional deterministic clock for accountObservedAt.
 * @returns Validated quota fields, or null when auth or discovery fails.
 */
export async function readXaiQuota(
  models: Models,
  now: () => string = () => new Date().toISOString()
): Promise<XaiQuotaObservation | null> {
  try {
    const apiKey = await resolveXaiApiKey(models);
    if (apiKey === null) {
      return null;
    }

    const { userId, ...discovery } = discoverXaiAccount(
      await readXaiJson(XAI_USER_URL, apiKey, XAI_USER_TIMEOUT_MS),
      now
    );
    try {
      return {
        ...discovery,
        availability: 'available',
        ...parseXaiBilling(
          await readXaiJson(XAI_BILLING_URL, apiKey, XAI_BILLING_TIMEOUT_MS, userId)
        ),
      };
    } catch {
      return { ...discovery, availability: 'temporarily_unavailable' };
    }
  } catch {
    return null;
  }
}

/**
 * Reads one current xAI auto-top-up rule through the pair-scoped pi-ai runtime.
 *
 * @param models Pair-scoped stock Models runtime.
 * @returns Validated auto-top-up fields, or null when any private reader step fails.
 */
export async function readXaiAutoTopup(models: Models): Promise<XaiAutoTopupObservation | null> {
  try {
    const apiKey = await resolveXaiApiKey(models);
    if (apiKey === null) {
      return null;
    }

    const { userId } = discoverXaiAccount(
      await readXaiJson(XAI_USER_URL, apiKey, XAI_USER_TIMEOUT_MS),
      () => new Date().toISOString()
    );
    return parseXaiAutoTopup(
      await readXaiJson(XAI_AUTO_TOPUP_URL, apiKey, XAI_AUTO_TOPUP_TIMEOUT_MS, userId)
    );
  } catch {
    return null;
  }
}

/**
 * Resolves the usable xAI bearer snapshot from stock pi-ai auth.
 *
 * @param models Pair-scoped stock Models runtime.
 * @returns Non-empty api key, or null when auth is absent or invalid.
 */
async function resolveXaiApiKey(models: Models): Promise<string | null> {
  const resolution = await models.getAuth('xai');
  const apiKey = resolution?.auth.apiKey;
  return typeof apiKey === 'string' && apiKey.length > 0 ? apiKey : null;
}

/**
 * Projects same-call discovery fields used by the immediately following request.
 *
 * @param value Parsed user JSON value.
 * @param now Clock for accountObservedAt.
 * @returns Canonical user id plus public discovery fields.
 */
function discoverXaiAccount(
  value: unknown,
  now: () => string
): XaiAccountDiscovery & { readonly userId: string } {
  if (!isRecord(value) || typeof value.userId !== 'string' || value.userId.length === 0) {
    throw new Error('xAI quota response is invalid.');
  }
  const { subscriptionTier } = value;
  if (
    subscriptionTier !== undefined &&
    subscriptionTier !== null &&
    typeof subscriptionTier !== 'string'
  ) {
    throw new Error('xAI quota response is invalid.');
  }
  const planType =
    typeof subscriptionTier === 'string' && subscriptionTier.length > 0
      ? subscriptionTier
      : undefined;
  return {
    accountObservedAt: now(),
    subscriptionActive:
      typeof subscriptionTier === 'string' &&
      subscriptionTier.length > 0 &&
      subscriptionTier !== 'Free',
    userId: value.userId,
    ...(planType === undefined ? {} : { planType }),
  };
}

/**
 * Issues one bounded xAI GET and returns its parsed JSON value.
 *
 * @param url Exact provider URL.
 * @param apiKey Resolved bearer snapshot.
 * @param timeoutMs Request-and-body deadline.
 * @param userId Canonical discovery user id, only for billing and auto-top-up.
 * @returns Parsed JSON value.
 */
async function readXaiJson(
  url: string,
  apiKey: string,
  timeoutMs: number,
  userId?: string
): Promise<unknown> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new DOMException('xAI quota request timed out.', 'TimeoutError'));
    }, timeoutMs);
  });

  try {
    const response = await Promise.race([
      fetch(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'X-XAI-Token-Auth': XAI_TOKEN_AUTH,
          'x-grok-client-version': XAI_CLIENT_VERSION,
          'x-grok-client-mode': XAI_CLIENT_MODE,
          ...(userId === undefined ? {} : { 'x-userid': userId }),
        },
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
      }),
      deadline,
    ]);
    if (!response.ok) {
      throw new Error('xAI quota response is unavailable.');
    }
    const bytes = await readResponseBytes(response, deadline);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

/**
 * Reads one response body without exceeding the fixed raw-byte ceiling.
 *
 * Codex and xAI keep private body readers because no shared HTTP body primitive
 * exists and the owner requires independently reviewed adapters, not a billing
 * framework.
 *
 * @param response Successful provider response.
 * @param deadline Cumulative request-and-body deadline.
 * @returns Complete raw response bytes.
 */
async function readResponseBytes(
  response: Response,
  deadline: Promise<never>
): Promise<Uint8Array> {
  if (!response.body) {
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) {
        break;
      }
      byteLength += value.byteLength;
      if (byteLength > MAX_XAI_USAGE_BODY_BYTES) {
        throw new Error('xAI quota response is too large.');
      }
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Validates consumed credits-config fields and projects windows plus billing.
 *
 * @param value Parsed JSON value.
 * @returns Available observation fields without guessed percentages.
 */
function parseXaiBilling(value: unknown): {
  billing?: XaiQuotaBilling;
  windows: XaiQuotaWindow[];
} {
  if (!isRecord(value) || !isRecord(value.config)) {
    throw new Error('xAI quota response is invalid.');
  }
  const {
    creditUsagePercent,
    currentPeriod,
    isUnifiedBillingUser,
    onDemandCap,
    onDemandUsed,
    prepaidBalance,
  } = value.config;
  const usedPercent = parseOptionalUsagePercent(creditUsagePercent);
  const period = parseOptionalPeriod(currentPeriod);
  const prepaidBalanceCents = parseOptionalCents(prepaidBalance);
  const onDemandUsedCents = parseOptionalCents(onDemandUsed);
  const onDemandCapCents = parseOptionalCents(onDemandCap);
  const sharedAllowance = parseOptionalBoolean(isUnifiedBillingUser);
  const hasUsage = usedPercent !== undefined;
  const hasPeriod =
    period.periodType !== undefined ||
    period.startsAt !== undefined ||
    period.resetsAt !== undefined;
  const billingFields = {
    ...(onDemandCapCents === undefined ? {} : { onDemandCapCents }),
    ...(onDemandUsedCents === undefined ? {} : { onDemandUsedCents }),
    ...(prepaidBalanceCents === undefined ? {} : { prepaidBalanceCents }),
    ...(sharedAllowance === undefined ? {} : { sharedAllowance }),
  };
  if (
    !hasUsage &&
    !hasPeriod &&
    onDemandCapCents === undefined &&
    onDemandUsedCents === undefined &&
    prepaidBalanceCents === undefined &&
    sharedAllowance === undefined
  ) {
    throw new Error('xAI quota response contains no recognized values.');
  }
  return {
    windows:
      hasUsage || hasPeriod
        ? [
            {
              id: 'included',
              ...(period.periodType === undefined ? {} : { periodType: period.periodType }),
              ...(usedPercent === undefined
                ? {}
                : { remainingPercent: 100 - usedPercent, usedPercent }),
              ...(period.resetsAt === undefined ? {} : { resetsAt: period.resetsAt }),
              ...(period.startsAt === undefined ? {} : { startsAt: period.startsAt }),
            },
          ]
        : [],
    ...(Object.keys(billingFields).length === 0
      ? {}
      : { billing: { currency: 'USD' as const, ...billingFields } }),
  };
}

/**
 * Validates consumed auto-top-up rule fields.
 *
 * @param value Parsed JSON value.
 * @returns Available auto-top-up observation.
 */
function parseXaiAutoTopup(value: unknown): XaiAutoTopupObservation {
  if (!isRecord(value)) {
    throw new Error('xAI quota response is invalid.');
  }
  if (value.rule === undefined || value.rule === null) {
    return { availability: 'available', currency: 'USD' };
  }
  if (!isRecord(value.rule)) {
    throw new Error('xAI quota response is invalid.');
  }
  if (value.rule.enabled !== undefined && typeof value.rule.enabled !== 'boolean') {
    throw new Error('xAI quota response is invalid.');
  }
  const thresholdCents = parseOptionalCents(value.rule.minBeforeHittingSl);
  const amountCents = parseOptionalCents(value.rule.topupAmount);
  const monthlyCapCents = parseOptionalCents(value.rule.maxAmountPerMonth);
  return {
    availability: 'available',
    currency: 'USD',
    enabled: value.rule.enabled === undefined ? false : value.rule.enabled,
    ...(amountCents === undefined ? {} : { amountCents }),
    ...(monthlyCapCents === undefined ? {} : { monthlyCapCents }),
    ...(thresholdCents === undefined ? {} : { thresholdCents }),
  };
}

/**
 * Parses optional included usage, treating absence and null as unknown.
 *
 * @param value Provider creditUsagePercent.
 * @returns Clamped used percent, or undefined when unknown.
 */
function parseOptionalUsagePercent(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('xAI quota response is invalid.');
  }
  return Math.min(100, value);
}

/**
 * Parses optional currentPeriod fields without inventing an unrecognized type.
 *
 * @param value Provider currentPeriod.
 * @returns Recognized period labels and canonical timestamps.
 */
function parseOptionalPeriod(value: unknown): {
  periodType?: 'weekly' | 'monthly';
  resetsAt?: string;
  startsAt?: string;
} {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error('xAI quota response is invalid.');
  }
  const periodType = parseOptionalPeriodType(value.type);
  const startsAt = parseOptionalTimestamp(value.start);
  const resetsAt = parseOptionalTimestamp(value.end);
  return {
    ...(periodType === undefined ? {} : { periodType }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
    ...(startsAt === undefined ? {} : { startsAt }),
  };
}

/**
 * Projects only the two recognized usage-period enum names.
 *
 * @param value Provider currentPeriod.type.
 * @returns weekly, monthly, or undefined when absent or unrecognized.
 */
function parseOptionalPeriodType(value: unknown): 'weekly' | 'monthly' | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error('xAI quota response is invalid.');
  }
  if (value === 'USAGE_PERIOD_TYPE_WEEKLY') {
    return 'weekly';
  }
  if (value === 'USAGE_PERIOD_TYPE_MONTHLY') {
    return 'monthly';
  }
  return undefined;
}

/**
 * Canonicalizes one optional RFC 3339 instant to UTC Date.toISOString form.
 *
 * @param value Provider timestamp string.
 * @returns Canonical timestamp, or undefined when unknown.
 */
function parseOptionalTimestamp(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error('xAI quota response is invalid.');
  }
  const parsed = XaiRfc3339TimestampSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('xAI quota response is invalid.');
  }
  const timestamp = new Date(parsed.data);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error('xAI quota response is invalid.');
  }
  return timestamp.toISOString();
}

/**
 * Parses one optional proto3 USD-cent object; {} is explicit zero.
 *
 * @param value Provider Cent object.
 * @returns Signed safe integer cents, or undefined when the object is absent.
 */
function parseOptionalCents(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error('xAI quota response is invalid.');
  }
  if (value.val === undefined) {
    return 0;
  }
  if (typeof value.val !== 'number' || !Number.isSafeInteger(value.val)) {
    throw new Error('xAI quota response is invalid.');
  }
  return value.val;
}

/**
 * Parses one optional boolean, treating absence and null as unknown.
 *
 * @param value Provider boolean field.
 * @returns Boolean value, or undefined when unknown.
 */
function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new Error('xAI quota response is invalid.');
  }
  return value;
}

/**
 * Checks whether a value is a non-array object.
 *
 * @param value Candidate value.
 * @returns True when the value supports named field access.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
