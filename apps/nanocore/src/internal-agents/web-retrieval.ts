import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { z } from 'zod';

import type { InternalCoreToolHandler } from './tools.js';
import type { InternalCoreToolId } from './types.js';

const DEFAULT_SEARCH_ENDPOINT = 'https://duckduckgo.com/html/';
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RESPONSE_BYTES = 128_000;
const DEFAULT_MAX_TEXT_CHARS = 8_000;
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_REDIRECTS = 5;
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
]);

/**
 * Resolves a hostname to IP addresses for outbound safety checks.
 */
export type WebRetrievalHostnameResolver = (hostname: string) => Promise<readonly string[]>;

/**
 * Options for creating bounded web retrieval handlers.
 */
export interface WebRetrievalToolHandlerOptions {
  /** Feature flag that allows quick-chat web retrieval. */
  readonly enabled: boolean;
  /** Fetch implementation used by tests and runtime. */
  readonly fetch?: typeof fetch;
  /** Timeout in milliseconds for outbound retrieval. */
  readonly timeoutMs?: number;
  /** Maximum response bytes read before the request fails. */
  readonly maxResponseBytes?: number;
  /** Maximum returned text characters. */
  readonly maxTextChars?: number;
  /** Search endpoint used for query retrieval. */
  readonly searchEndpoint?: string;
  /** Hostname resolver used to block private DNS targets. */
  readonly resolveHostname?: WebRetrievalHostnameResolver;
}

/**
 * Source record returned by web retrieval tools.
 */
export interface WebRetrievalSource {
  /** Source URL suitable for display or audit. */
  readonly url: string;
  /** Optional source title. */
  readonly title?: string;
}

/**
 * Output returned by the web search Core tool.
 */
export interface WebSearchToolOutput {
  /** Search query. */
  readonly query: string;
  /** Search URL fetched by Core. */
  readonly sourceUrl: string;
  /** Bounded source list extracted from the search page. */
  readonly sources: WebRetrievalSource[];
}

/**
 * Output returned by the page text Core tool.
 */
export interface FetchPageTextToolOutput {
  /** Page URL fetched by Core. */
  readonly sourceUrl: string;
  /** Page title when found. */
  readonly title: string | null;
  /** Bounded text extracted from the page. */
  readonly text: string;
  /** Source records suitable for display or audit. */
  readonly sources: WebRetrievalSource[];
}

/**
 * Error raised by bounded web retrieval tools.
 */
export class InternalWebRetrievalError extends Error {
  /** Stable app-local error code. */
  public readonly code:
    | 'internal_web_retrieval_disabled'
    | 'internal_web_retrieval_invalid_url'
    | 'internal_web_retrieval_limit_exceeded'
    | 'internal_web_retrieval_request_failed'
    | 'internal_web_retrieval_unsupported_content';

  /**
   * Creates one web retrieval error.
   *
   * @param code Stable app-local error code.
   * @param message Human-readable error message.
   */
  public constructor(code: InternalWebRetrievalError['code'], message: string) {
    super(message);
    this.name = 'InternalWebRetrievalError';
    this.code = code;
  }
}

const WebSearchInputSchema = z.object({
  query: z.string().trim().min(1),
  limit: z.number().int().min(1).max(10).optional(),
});

const FetchPageTextInputSchema = z.object({
  url: z.string().trim().min(1),
});

/**
 * Creates bounded web search and page-fetch handlers for internal Core tools.
 *
 * @param options Feature flag, transport, and limit options.
 * @returns Handler map for `webSearch` and `fetchPageText`.
 */
export function createWebRetrievalToolHandlers(
  options: WebRetrievalToolHandlerOptions
): Partial<Record<InternalCoreToolId, InternalCoreToolHandler>> {
  const dependencies = normalizeOptions(options);

  return {
    webSearch: async ({ input }) => runWebSearch(input, dependencies),
    fetchPageText: async ({ input }) => runFetchPageText(input, dependencies),
  };
}

interface NormalizedWebRetrievalOptions {
  enabled: boolean;
  fetch: typeof fetch;
  maxResponseBytes: number;
  maxTextChars: number;
  resolveHostname: WebRetrievalHostnameResolver;
  searchEndpoint: string;
  timeoutMs: number;
}

/**
 * Normalizes web retrieval options.
 *
 * @param options Web retrieval handler options.
 * @returns Fully populated options.
 */
function normalizeOptions(options: WebRetrievalToolHandlerOptions): NormalizedWebRetrievalOptions {
  return {
    enabled: options.enabled,
    fetch: options.fetch ?? fetch,
    maxResponseBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    maxTextChars: options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS,
    resolveHostname: options.resolveHostname ?? resolveHostnameWithDns,
    searchEndpoint: options.searchEndpoint ?? DEFAULT_SEARCH_ENDPOINT,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

/**
 * Resolves a hostname through Node DNS.
 *
 * @param hostname Hostname to resolve.
 * @returns Resolved IP address strings.
 */
async function resolveHostnameWithDns(hostname: string): Promise<readonly string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });

  return records.map((record) => record.address);
}

/**
 * Runs one bounded web search.
 *
 * @param input Tool input.
 * @param options Normalized retrieval options.
 * @returns Search output with source URLs.
 */
async function runWebSearch(
  input: unknown,
  options: NormalizedWebRetrievalOptions
): Promise<WebSearchToolOutput> {
  ensureEnabled(options);
  const parsed = WebSearchInputSchema.parse(input);
  const sourceUrl = createSearchUrl(options.searchEndpoint, parsed.query);
  const response = await fetchText(sourceUrl, options);
  const sources = extractSearchSources(response.text, parsed.limit ?? DEFAULT_SEARCH_LIMIT);

  return {
    query: parsed.query,
    sourceUrl,
    sources: sources.length > 0 ? sources : [{ title: 'Search results', url: sourceUrl }],
  };
}

/**
 * Runs one bounded page text fetch.
 *
 * @param input Tool input.
 * @param options Normalized retrieval options.
 * @returns Page text output with source URL.
 */
async function runFetchPageText(
  input: unknown,
  options: NormalizedWebRetrievalOptions
): Promise<FetchPageTextToolOutput> {
  ensureEnabled(options);
  const parsed = FetchPageTextInputSchema.parse(input);
  const url = normalizeHttpUrl(parsed.url);
  const response = await fetchText(url, options);
  const title = extractTitle(response.text);
  const text = htmlToText(response.text).slice(0, options.maxTextChars);

  return {
    sourceUrl: url,
    title,
    text,
    sources: [{ ...(title ? { title } : {}), url }],
  };
}

/**
 * Throws when web retrieval is disabled.
 *
 * @param options Normalized retrieval options.
 * @throws InternalWebRetrievalError when disabled.
 */
function ensureEnabled(options: NormalizedWebRetrievalOptions): void {
  if (!options.enabled) {
    throw new InternalWebRetrievalError(
      'internal_web_retrieval_disabled',
      'Quick chat web retrieval is disabled.'
    );
  }
}

/**
 * Creates a search URL for one query.
 *
 * @param endpoint Search endpoint.
 * @param query Search query.
 * @returns Search URL.
 */
function createSearchUrl(endpoint: string, query: string): string {
  const url = new URL(endpoint);

  url.searchParams.set('q', query);
  return normalizeHttpUrl(url.toString());
}

/**
 * Validates a public HTTP or HTTPS URL.
 *
 * @param value Raw URL.
 * @returns Normalized URL.
 * @throws InternalWebRetrievalError when the URL is unsupported.
 */
function normalizeHttpUrl(value: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new InternalWebRetrievalError(
      'internal_web_retrieval_invalid_url',
      'Web retrieval requires an absolute HTTP or HTTPS URL.'
    );
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new InternalWebRetrievalError(
      'internal_web_retrieval_invalid_url',
      'Web retrieval allows only HTTP and HTTPS URLs.'
    );
  }

  assertPublicHostname(url);
  url.username = '';
  url.password = '';
  return url.toString();
}

/**
 * Resolves and validates a public HTTP or HTTPS URL.
 *
 * @param value Raw URL.
 * @param options Normalized retrieval options.
 * @returns Normalized URL.
 * @throws InternalWebRetrievalError when the URL host is unsafe or cannot be resolved.
 */
async function resolvePublicHttpUrl(
  value: string,
  options: NormalizedWebRetrievalOptions,
  deadline: WebRetrievalDeadline
): Promise<string> {
  const normalized = normalizeHttpUrl(value);
  const url = new URL(normalized);
  const hostname = normalizeHostname(url.hostname);

  if (isIpAddress(hostname)) {
    return normalized;
  }

  let addresses: readonly string[];

  try {
    addresses = await withWebRetrievalDeadline(deadline, () => options.resolveHostname(hostname));
  } catch (error) {
    if (isWebRetrievalTimeoutError(error)) {
      throw error;
    }

    throw new InternalWebRetrievalError(
      'internal_web_retrieval_request_failed',
      'Web retrieval hostname could not be resolved.'
    );
  }

  if (addresses.length === 0) {
    throw new InternalWebRetrievalError(
      'internal_web_retrieval_request_failed',
      'Web retrieval hostname could not be resolved.'
    );
  }

  if (addresses.some((address) => isBlockedIpAddress(normalizeHostname(address)))) {
    throw new InternalWebRetrievalError(
      'internal_web_retrieval_invalid_url',
      'Web retrieval requires a public HTTP or HTTPS URL.'
    );
  }

  return normalized;
}

/**
 * Rejects local, private, and metadata-service URL hosts.
 *
 * @param url URL to inspect.
 * @throws InternalWebRetrievalError when the host is not public.
 */
function assertPublicHostname(url: URL): void {
  const hostname = normalizeHostname(url.hostname);

  if (BLOCKED_HOSTNAMES.has(hostname) || isBlockedIpAddress(hostname)) {
    throw new InternalWebRetrievalError(
      'internal_web_retrieval_invalid_url',
      'Web retrieval requires a public HTTP or HTTPS URL.'
    );
  }
}

/**
 * Returns true when a normalized hostname is an IP address.
 *
 * @param hostname Normalized hostname.
 * @returns True when the hostname is IPv4 or IPv6.
 */
function isIpAddress(hostname: string): boolean {
  return isIP(hostname) !== 0;
}

/**
 * Returns true for IP addresses that are unsafe for outbound web retrieval.
 *
 * @param address Normalized IP address.
 * @returns True when the address is local, private, link-local, reserved, or multicast.
 */
function isBlockedIpAddress(address: string): boolean {
  const version = isIP(address);

  if (version === 4) {
    return isPrivateIpv4(address);
  }
  if (version === 6) {
    return isPrivateIpv6(address);
  }

  return false;
}

/**
 * Normalizes a URL hostname for safety checks.
 *
 * @param hostname URL hostname.
 * @returns Lowercase hostname without brackets or trailing root dot.
 */
function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
}

/**
 * Parses a dotted IPv4 address.
 *
 * @param hostname Hostname candidate.
 * @returns Four IPv4 octets, or null when the hostname is not a plain IPv4 address.
 */
function parseIpv4(hostname: string): [number, number, number, number] | null {
  const parts = hostname.split('.');

  if (parts.length !== 4) {
    return null;
  }

  const octets = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN));

  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }

  return octets as [number, number, number, number];
}

/**
 * Returns true for IPv4 ranges that are unsafe for outbound web retrieval.
 *
 * @param hostname Hostname candidate.
 * @returns True when the host is local, private, link-local, reserved, or multicast.
 */
function isPrivateIpv4(hostname: string): boolean {
  const octets = parseIpv4(hostname);

  if (!octets) {
    return false;
  }

  const [first, second, third] = octets;

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

/**
 * Returns true for IPv6 ranges that are unsafe for outbound web retrieval.
 *
 * @param hostname Hostname candidate.
 * @returns True when the host is local, private, link-local, or multicast.
 */
function isPrivateIpv6(hostname: string): boolean {
  if (!hostname.includes(':')) {
    return false;
  }

  if (hostname === '::' || hostname === '::1') {
    return true;
  }

  const mappedIpv4 = parseIpv4MappedIpv6(hostname);

  if (mappedIpv4) {
    return isPrivateIpv4(mappedIpv4);
  }

  const firstHextet = parseFirstIpv6Hextet(hostname);

  if (firstHextet === null) {
    return true;
  }

  return (
    (firstHextet & 0xfe00) === 0xfc00 ||
    (firstHextet & 0xffc0) === 0xfe80 ||
    (firstHextet & 0xff00) === 0xff00
  );
}

/**
 * Parses IPv4-mapped IPv6 addresses into dotted IPv4.
 *
 * @param hostname IPv6 address candidate.
 * @returns Dotted IPv4 address, or null when the address is not IPv4-mapped.
 */
function parseIpv4MappedIpv6(hostname: string): string | null {
  if (!hostname.startsWith('::ffff:')) {
    return null;
  }

  const suffix = hostname.slice('::ffff:'.length);

  if (parseIpv4(suffix)) {
    return suffix;
  }

  const parts = suffix.split(':');

  if (parts.length !== 2) {
    return '0.0.0.0';
  }

  const high = parseHextet(parts[0]);
  const low = parseHextet(parts[1]);

  if (high === null || low === null) {
    return '0.0.0.0';
  }

  return `${(high >> 8) & 255}.${high & 255}.${(low >> 8) & 255}.${low & 255}`;
}

/**
 * Parses the first visible IPv6 hextet.
 *
 * @param hostname IPv6 address candidate.
 * @returns First hextet value, or null when it cannot be parsed.
 */
function parseFirstIpv6Hextet(hostname: string): number | null {
  const [firstSegment] = hostname.split(':');

  if (!firstSegment) {
    return 0;
  }

  return parseHextet(firstSegment);
}

/**
 * Parses one IPv6 hextet.
 *
 * @param value Hextet text.
 * @returns Numeric hextet, or null when invalid.
 */
function parseHextet(value: string | undefined): number | null {
  if (!value || !/^[0-9a-f]{1,4}$/i.test(value)) {
    return null;
  }

  return Number.parseInt(value, 16);
}

interface FetchedText {
  text: string;
}

interface WebRetrievalDeadline {
  /** Abort signal shared by DNS resolution, fetch, and body reads. */
  readonly signal: AbortSignal;
  /** Clears the timer backing this deadline. */
  dispose(): void;
}

/**
 * Fetches bounded text through a credential-free GET request.
 *
 * @param url URL to fetch.
 * @param options Normalized retrieval options.
 * @returns Fetched text.
 * @throws InternalWebRetrievalError on unsupported content, failed request, timeout, or limit breach.
 */
async function fetchText(
  url: string,
  options: NormalizedWebRetrievalOptions
): Promise<FetchedText> {
  const deadline = createWebRetrievalDeadline(options.timeoutMs);

  try {
    return await fetchTextWithDeadline(url, options, deadline, 0);
  } catch (error) {
    throw normalizeWebRetrievalError(error, deadline);
  } finally {
    deadline.dispose();
  }
}

/**
 * Fetches bounded text while sharing one timeout budget across redirects.
 *
 * @param url URL to fetch.
 * @param options Normalized retrieval options.
 * @param deadline Shared retrieval deadline.
 * @param redirectCount Number of redirects followed so far.
 * @returns Fetched text.
 * @throws InternalWebRetrievalError on unsupported content, failed request, timeout, or limit breach.
 */
async function fetchTextWithDeadline(
  url: string,
  options: NormalizedWebRetrievalOptions,
  deadline: WebRetrievalDeadline,
  redirectCount = 0
): Promise<FetchedText> {
  const safeUrl = await resolvePublicHttpUrl(url, options, deadline);
  const request = new Request(safeUrl, {
    credentials: 'omit',
    headers: {
      accept: 'text/html,text/plain,application/xhtml+xml,application/json;q=0.5',
      'user-agent': 'OpenKit-NanoCore/0.0.5',
    },
    method: 'GET',
    redirect: 'manual',
    signal: deadline.signal,
  });
  const response = await withWebRetrievalDeadline(deadline, () => options.fetch(request));

  if (isRedirectResponse(response)) {
    const location = response.headers.get('location');

    if (!location || redirectCount >= MAX_REDIRECTS) {
      throw new InternalWebRetrievalError(
        'internal_web_retrieval_request_failed',
        'Web retrieval redirect could not be followed.'
      );
    }

    return fetchTextWithDeadline(
      new URL(location, safeUrl).toString(),
      options,
      deadline,
      redirectCount + 1
    );
  }

  if (!response.ok) {
    throw new InternalWebRetrievalError(
      'internal_web_retrieval_request_failed',
      `Web retrieval failed with status ${response.status}.`
    );
  }

  assertSupportedContentType(response.headers.get('content-type'));
  return {
    text: await withWebRetrievalDeadline(deadline, () =>
      readBoundedResponseText(response, options.maxResponseBytes)
    ),
  };
}

/**
 * Creates one shared retrieval deadline.
 *
 * @param timeoutMs Timeout budget in milliseconds.
 * @returns Deadline with abort signal and cleanup function.
 */
function createWebRetrievalDeadline(timeoutMs: number): WebRetrievalDeadline {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timeout),
  };
}

/**
 * Bounds an async operation by the shared web retrieval deadline.
 *
 * @param deadline Shared retrieval deadline.
 * @param task Async task factory to bound.
 * @returns Task result when it completes before the deadline.
 * @throws InternalWebRetrievalError when the deadline has expired.
 */
async function withWebRetrievalDeadline<T>(
  deadline: WebRetrievalDeadline,
  task: () => Promise<T>
): Promise<T> {
  if (deadline.signal.aborted) {
    throw createWebRetrievalTimeoutError();
  }

  let removeAbortListener = () => {};
  const timeout = new Promise<never>((_resolve, reject) => {
    const onAbort = () => {
      reject(createWebRetrievalTimeoutError());
    };

    deadline.signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => deadline.signal.removeEventListener('abort', onAbort);
  });

  try {
    return await Promise.race([task(), timeout]);
  } finally {
    removeAbortListener();
  }
}

/**
 * Normalizes unexpected transport errors to bounded web retrieval errors.
 *
 * @param error Original error.
 * @param deadline Shared retrieval deadline.
 * @returns Web retrieval error safe for callers.
 */
function normalizeWebRetrievalError(error: unknown, deadline: WebRetrievalDeadline): Error {
  if (error instanceof InternalWebRetrievalError) {
    return error;
  }
  if (deadline.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
    return createWebRetrievalTimeoutError();
  }

  return new InternalWebRetrievalError(
    'internal_web_retrieval_request_failed',
    error instanceof Error ? error.message : String(error)
  );
}

/**
 * Creates the stable timeout error for web retrieval.
 *
 * @returns Web retrieval timeout error.
 */
function createWebRetrievalTimeoutError(): InternalWebRetrievalError {
  return new InternalWebRetrievalError(
    'internal_web_retrieval_request_failed',
    'Web retrieval timed out.'
  );
}

/**
 * Returns true when an error is the stable web retrieval timeout error.
 *
 * @param error Error to inspect.
 * @returns True when the error represents deadline expiry.
 */
function isWebRetrievalTimeoutError(error: unknown): boolean {
  return (
    error instanceof InternalWebRetrievalError &&
    error.code === 'internal_web_retrieval_request_failed' &&
    error.message === 'Web retrieval timed out.'
  );
}

/**
 * Returns true when an HTTP response is a redirect that needs URL revalidation.
 *
 * @param response Fetch response.
 * @returns True for HTTP 3xx redirect statuses.
 */
function isRedirectResponse(response: Response): boolean {
  return response.status >= 300 && response.status < 400;
}

/**
 * Rejects unsupported response content types.
 *
 * @param contentType Response content type header.
 * @throws InternalWebRetrievalError when content is not text-like.
 */
function assertSupportedContentType(contentType: string | null): void {
  if (!contentType) {
    return;
  }

  const normalized = contentType.toLowerCase();
  const supported =
    normalized.includes('text/html') ||
    normalized.includes('text/plain') ||
    normalized.includes('application/xhtml+xml') ||
    normalized.includes('application/json');

  if (!supported) {
    throw new InternalWebRetrievalError(
      'internal_web_retrieval_unsupported_content',
      `Unsupported web retrieval content type: ${contentType}.`
    );
  }
}

/**
 * Reads response text without exceeding the configured byte limit.
 *
 * @param response Fetch response.
 * @param maxBytes Maximum bytes to read.
 * @returns Decoded response text.
 * @throws InternalWebRetrievalError when the response exceeds the limit.
 */
async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const text = await response.text();

    if (Buffer.byteLength(text) > maxBytes) {
      throw new InternalWebRetrievalError(
        'internal_web_retrieval_limit_exceeded',
        'Web retrieval response exceeded the configured byte limit.'
      );
    }

    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let received = 0;

  try {
    while (true) {
      const next = await reader.read();

      if (next.done) {
        break;
      }

      received += next.value.byteLength;
      if (received > maxBytes) {
        throw new InternalWebRetrievalError(
          'internal_web_retrieval_limit_exceeded',
          'Web retrieval response exceeded the configured byte limit.'
        );
      }

      chunks.push(decoder.decode(next.value, { stream: true }));
    }

    chunks.push(decoder.decode());
    return chunks.join('');
  } finally {
    reader.releaseLock();
  }
}

/**
 * Extracts source links from a search result page.
 *
 * @param html Search result HTML.
 * @param limit Maximum number of sources.
 * @returns Extracted source records.
 */
function extractSearchSources(html: string, limit: number): WebRetrievalSource[] {
  const sources: WebRetrievalSource[] = [];
  const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis;

  for (const match of html.matchAll(anchorPattern)) {
    const rawHref = match[1];
    const rawTitle = match[2];
    const url = normalizeSearchResultUrl(rawHref);

    if (!url) {
      continue;
    }

    sources.push({ title: htmlToText(rawTitle), url });
    if (sources.length >= limit) {
      break;
    }
  }

  return sources;
}

/**
 * Normalizes a search-result href into an HTTP URL.
 *
 * @param href Raw anchor href.
 * @returns Normalized source URL, or null when unsupported.
 */
function normalizeSearchResultUrl(href: string | undefined): string | null {
  if (!href) {
    return null;
  }

  try {
    if (href.startsWith('/l/?')) {
      const redirect = new URL(href, 'https://duckduckgo.com');
      const target = redirect.searchParams.get('uddg');

      return target ? normalizeHttpUrl(target) : null;
    }

    return normalizeHttpUrl(href);
  } catch {
    return null;
  }
}

/**
 * Extracts an HTML title.
 *
 * @param html Page HTML.
 * @returns Text title, or null when absent.
 */
function extractTitle(html: string): string | null {
  const title = /<title\b[^>]*>(.*?)<\/title>/is.exec(html)?.[1];

  return title ? htmlToText(title) : null;
}

/**
 * Converts simple HTML into compact text.
 *
 * @param html HTML or plain text.
 * @returns Compact decoded text.
 */
function htmlToText(html: string | undefined): string {
  return decodeHtmlEntities(
    (html ?? '')
      .replace(/<script\b[^>]*>.*?<\/script>/gis, ' ')
      .replace(/<style\b[^>]*>.*?<\/style>/gis, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Decodes the small entity subset needed for readable search and page text.
 *
 * @param text Encoded text.
 * @returns Decoded text.
 */
function decodeHtmlEntities(text: string): string {
  return text
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}
