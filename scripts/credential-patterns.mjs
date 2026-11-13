/** Known credential forms only; a clean result is not a confidentiality proof. */
export const CREDENTIAL_PATTERN =
  /(?<tokenPrefix>\b(?:gh[pousr]_|github_pat_|okt_|okw_|sk-)(?!FAKE_)[A-Za-z0-9_-]{8,})|(?<jwt>\beyJ(?!FAKE_)[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)|(?<awsAccessKey>\b(?:AKIA|ASIA)[A-Z0-9]{16})|(?<privateKey>-----BEGIN (?!FAKE )[A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$))|(?<urlCredentials>[a-z]+:\/\/(?!FAKE_)[A-Za-z0-9._~!$&'()*+,;=%-]+:(?!FAKE_)[A-Za-z0-9._~!$&'()*+,;=:%-]+@)/gi;

/**
 * Locate known forms without returning any matched credential value.
 *
 * @param {string} text Text to inspect.
 * @returns {{line: number, pattern: string}[]} Value-free diagnostic locations.
 */
export function findCredentialForms(text) {
  const locations = [];
  let cursor = 0;
  let line = 1;
  for (const match of text.matchAll(new RegExp(CREDENTIAL_PATTERN))) {
    while (cursor < match.index) {
      if (text.charCodeAt(cursor) === 10) line += 1;
      cursor += 1;
    }
    const pattern = Object.keys(match.groups).find((key) => match.groups[key] !== undefined);
    if (!pattern) throw Error('Unclassified credential form');
    locations.push({ line, pattern });
  }
  return locations;
}
