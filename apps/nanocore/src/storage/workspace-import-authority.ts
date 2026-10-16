const PORTABLE_IMPORT_AUTHORITY_PREFIXES = ['apr_imported_'] as const;

/**
 * Checks whether one Approval identity was issued on the current deployment.
 *
 * Portable import owns the reserved prefixes and preserves those rows only as history.
 *
 * @param authorityId Approval identity required by an effect consumer. VaultGrant uses its canonical issuance field.
 * @returns True only for a present identity outside the portable-import namespaces.
 */
export function isTargetIssuedEffectAuthority(authorityId: string | null): boolean {
  return (
    authorityId !== null &&
    authorityId.trim().length > 0 &&
    !PORTABLE_IMPORT_AUTHORITY_PREFIXES.some((prefix) => authorityId.startsWith(prefix))
  );
}
