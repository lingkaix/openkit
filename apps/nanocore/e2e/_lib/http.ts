/**
 * Extracts cookie pairs from Set-Cookie headers for follow-up HTTP requests.
 */
export function cookieHeader(response: Response): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies =
    headers.getSetCookie?.() ?? splitSetCookieHeader(response.headers.get('set-cookie'));

  if (setCookies.length === 0) {
    throw new Error('Expected response to include Set-Cookie.');
  }

  return setCookies.map((cookie) => cookie.split(';')[0]).join('; ');
}

/**
 * Posts a JSON request and returns the raw HTTP response.
 */
export async function postJson(
  url: string,
  body: Record<string, unknown>,
  cookie?: string
): Promise<Response> {
  return await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

/**
 * Splits a combined Set-Cookie header value when the runtime does not expose getSetCookie.
 */
function splitSetCookieHeader(header: string | null): string[] {
  if (!header) {
    return [];
  }

  return header.split(/,(?=\s*[^;,]+=)/).map((cookie) => cookie.trim());
}
