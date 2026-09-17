import type { Models } from '@earendil-works/pi-ai';
import { z } from 'zod';

const XAI_USER_URL = 'https://cli-chat-proxy.grok.com/v1/user?include=subscription';
const XAI_BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';
const XAI_USER_TIMEOUT_MS = 10_000;
const XAI_BILLING_TIMEOUT_MS = 15_000;
const MAX_XAI_USAGE_BODY_BYTES = 65_536;
const XAI_TOKEN_AUTH = 'xai-grok-cli';
const XAI_CLIENT_VERSION = '1.0.12';
const XAI_CLIENT_MODE = 'headless';
const XaiRfc3339TimestampSchema = z.string().datetime({ offset: true });

/** One validated xAI credits window projected through the App API. */
interface XaiQuotaWindow {
  /** Stable OpenKit window identifier. */
  readonly id: 'included';
  /** Percentage of included credits that remains. */
  readonly remainingPercent?: number;
  /** Canonical reset timestamp, when the provider supplied a valid period end. */
  readonly resetsAt?: string;
  /** Provider-reported included-credit usage, clamped to 0..100. */
  readonly usedPercent?: number;
}

/** Validated provider quota fields consumed by the App API route. */
export interface XaiQuotaObservation {
  /** Exact provider subscription tier, when discovery supplied one. */
  readonly planType?: string;
  /** Single included-credits window. */
  readonly windows: [XaiQuotaWindow];
}

/**
 * Reads one current xAI credits observation through the pair-scoped pi-ai runtime.
 *
 * @param models Pair-scoped stock Models runtime.
 * @returns Validated quota fields, or null when any private reader step fails.
 */
export async function readXaiQuota(models: Models): Promise<XaiQuotaObservation | null> {
  try {
    const resolution = await models.getAuth('xai');
    const apiKey = resolution?.auth.apiKey;
    if (typeof apiKey !== 'string' || apiKey.length === 0) {
      return null;
    }

    const user = parseXaiUser(await readXaiJson(XAI_USER_URL, apiKey, XAI_USER_TIMEOUT_MS));
    const billing = parseXaiBilling(
      await readXaiJson(XAI_BILLING_URL, apiKey, XAI_BILLING_TIMEOUT_MS, user.userId)
    );
    const window: XaiQuotaWindow = {
      id: 'included',
      ...(billing.usedPercent === undefined
        ? {}
        : { remainingPercent: 100 - billing.usedPercent, usedPercent: billing.usedPercent }),
      ...(billing.resetsAt === undefined ? {} : { resetsAt: billing.resetsAt }),
    };
    return {
      windows: [window],
      ...(user.planType === undefined ? {} : { planType: user.planType }),
    };
  } catch {
    return null;
  }
}

/**
 * Issues one bounded xAI quota GET and returns its parsed JSON value.
 *
 * @param url Exact provider URL.
 * @param apiKey Resolved bearer snapshot.
 * @param timeoutMs Request-and-body deadline.
 * @param userId Canonical discovery user id, only for the billing request.
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
 * Validates identity discovery fields used by the immediately following billing request.
 *
 * @param value Parsed JSON value.
 * @returns Canonical user id and optional public plan type.
 */
function parseXaiUser(value: unknown): { planType?: string; userId: string } {
  if (!isRecord(value) || typeof value.userId !== 'string' || value.userId.length === 0) {
    throw new Error('xAI quota response is invalid.');
  }
  if (value.subscriptionTier === undefined) {
    return { userId: value.userId };
  }
  if (typeof value.subscriptionTier !== 'string' || value.subscriptionTier.length === 0) {
    throw new Error('xAI quota response is invalid.');
  }
  return { planType: value.subscriptionTier, userId: value.userId };
}

/**
 * Validates consumed credits-config fields and projects the public included window.
 *
 * @param value Parsed JSON value.
 * @returns Supplied clamped usage and/or canonical reset timestamp, without guessed percentages.
 */
function parseXaiBilling(value: unknown): { resetsAt?: string; usedPercent?: number } {
  if (!isRecord(value) || !isRecord(value.config)) {
    throw new Error('xAI quota response is invalid.');
  }
  const { creditUsagePercent, currentPeriod } = value.config;
  if (
    creditUsagePercent !== undefined &&
    (typeof creditUsagePercent !== 'number' ||
      !Number.isFinite(creditUsagePercent) ||
      creditUsagePercent < 0)
  ) {
    throw new Error('xAI quota response is invalid.');
  }
  const usage =
    creditUsagePercent === undefined ? {} : { usedPercent: Math.min(100, creditUsagePercent) };
  if (currentPeriod !== undefined && !isRecord(currentPeriod)) {
    throw new Error('xAI quota response is invalid.');
  }
  if (currentPeriod?.end === undefined) {
    if (creditUsagePercent === undefined) {
      throw new Error('xAI quota response contains no recognized values.');
    }
    return usage;
  }
  const parsedEnd = XaiRfc3339TimestampSchema.safeParse(currentPeriod.end);
  if (!parsedEnd.success) {
    throw new Error('xAI quota response is invalid.');
  }
  const resetsAt = new Date(parsedEnd.data);
  if (Number.isNaN(resetsAt.getTime())) {
    throw new Error('xAI quota response is invalid.');
  }
  return { resetsAt: resetsAt.toISOString(), ...usage };
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
