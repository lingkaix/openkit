const PORTABLE_IMPORT_AUTHORITY_PREFIXES = ['apr_imported_', 'grant_imported_'] as const;

/**
 * Checks whether one effect-authority identity was issued on the current deployment.
 *
 * Portable import owns the reserved prefixes and preserves those rows only as history.
 *
 * @param authorityId Approval or VaultGrant identity required by an effect consumer.
 * @returns True only for a present identity outside the portable-import namespaces.
 */
export function isTargetIssuedEffectAuthority(authorityId: string | null): boolean {
  return (
    authorityId !== null &&
    authorityId.trim().length > 0 &&
    !PORTABLE_IMPORT_AUTHORITY_PREFIXES.some((prefix) => authorityId.startsWith(prefix))
  );
}
