import { readFileSync } from 'node:fs';

const snapshotRoot = new URL('../snapshots/2026-07-05/', import.meta.url);
const metadata = readSnapshotJson<OpenShellSnapshotMetadata>('metadata.json');
const providerProfileSurface = readSnapshotJson<OpenShellProviderProfileSurfaceFile>(
  'provider-profile-surface.json'
);
const policySurface = readSnapshotJson<OpenShellPolicySurfaceFile>('policy-surface.json');
const cliSurface = readSnapshotJson<OpenShellCliSurfaceFile>('cli-surface.json');

/** Current OpenShell schema snapshot id pinned by OpenKit. */
export const OPEN_SHELL_SCHEMA_SNAPSHOT_ID = metadata.snapshotId;

/** Current OpenShell mapping version used by OpenKit derivation code. */
export const OPEN_SHELL_MAPPING_VERSION = metadata.mappingVersion;

/** OpenShell snapshot metadata. */
export const OPEN_SHELL_SCHEMA_SNAPSHOT = metadata;

/** Provider profile surface pinned by the snapshot. */
export const OPEN_SHELL_PROVIDER_PROFILE_SURFACE = providerProfileSurface.providerProfile;

/** Sandbox policy surface pinned by the snapshot. */
export const OPEN_SHELL_POLICY_SURFACE = policySurface.sandboxPolicy;

/** CLI surface pinned by the snapshot. */
export const OPEN_SHELL_CLI_SURFACE = cliSurface.cli;

/** OpenShell snapshot metadata shape. */
interface OpenShellSnapshotMetadata {
  readonly checksums: Record<string, string>;
  readonly compatibleGatewayRange: {
    readonly maxExclusive: string;
    readonly min: string;
  };
  readonly mappingVersion: string;
  readonly refreshedAt: string;
  readonly snapshotId: string;
  readonly sourceBoundary: string;
}

/** Provider profile snapshot file shape. */
interface OpenShellProviderProfileSurfaceFile {
  readonly providerProfile: {
    readonly authStyles: string[];
    readonly categories: string[];
    readonly credentialFields: string[];
    readonly gatewayDelegatedRefreshStrategies: string[];
    readonly refreshMaterialKeys: string[];
    readonly refreshStrategies: string[];
    readonly requiredFields: string[];
    readonly reservedEnvPrefixPattern: string;
    readonly reservedProfileIds: string[];
  };
  readonly schemaVersion: number;
}

/** Policy snapshot file shape. */
interface OpenShellPolicySurfaceFile {
  readonly sandboxPolicy: {
    readonly accessModes: string[];
    readonly endpointKeys: string[];
    readonly enforcements: string[];
    readonly filesystemPolicyKeys: string[];
    readonly networkPolicyEntryKeys: string[];
    readonly protocols: string[];
    readonly providerLayerPrefix: string;
    readonly providersV2Required: boolean;
    readonly requiredTopLevelKeys: string[];
    readonly version: number;
  };
  readonly schemaVersion: number;
}

/** CLI snapshot file shape. */
interface OpenShellCliSurfaceFile {
  readonly cli: {
    readonly binary: string;
    readonly commands: string[][];
    readonly compatibleVersionRange: {
      readonly maxExclusive: string;
      readonly min: string;
    };
  };
  readonly schemaVersion: number;
}

/** Minimal OpenShell provider profile artifact validated by this snapshot. */
export interface OpenShellProviderProfileArtifact {
  /** Generated provider profile id. */
  readonly id: string;
  /** Provider profile category. */
  readonly category: string;
  /** Human-readable display name. */
  readonly displayName: string;
  /** Credential declarations keyed by logical credential id. */
  readonly credentials: Record<
    string,
    {
      readonly authStyle?: string;
      readonly envVar: string;
      readonly headerName?: string;
      readonly pathTemplate?: string;
      readonly queryParam?: string;
    }
  >;
  /** Endpoint declarations keyed by endpoint id. */
  readonly endpoints: Record<string, unknown>;
  /** Optional refresh strategy declaration. */
  readonly refresh?: {
    readonly materialKeys?: readonly string[];
    readonly strategy: string;
  };
}

/**
 * Validates a generated OpenShell provider profile against the pinned surface.
 *
 * @param profile Generated provider profile artifact.
 * @throws Error when the profile uses unsupported fields or reserved namespaces.
 */
export function assertOpenShellProviderProfileConformant(
  profile: OpenShellProviderProfileArtifact
): void {
  assertIdentifier(profile.id, 'OpenShell provider profile id');

  if (OPEN_SHELL_PROVIDER_PROFILE_SURFACE.reservedProfileIds.includes(profile.id)) {
    throw new Error(`OpenShell provider profile id is reserved: ${profile.id}`);
  }
  if (!OPEN_SHELL_PROVIDER_PROFILE_SURFACE.categories.includes(profile.category)) {
    throw new Error(`Unsupported OpenShell provider profile category: ${profile.category}`);
  }
  if (!profile.displayName.trim()) {
    throw new Error('OpenShell provider profile displayName is required.');
  }

  for (const [credentialId, credential] of Object.entries(profile.credentials)) {
    assertIdentifier(credentialId, 'OpenShell provider credential id');

    if (!credential.envVar.trim()) {
      throw new Error(`OpenShell provider credential ${credentialId} envVar is required.`);
    }
    if (
      new RegExp(OPEN_SHELL_PROVIDER_PROFILE_SURFACE.reservedEnvPrefixPattern).test(
        credential.envVar
      )
    ) {
      throw new Error(
        `OpenShell provider credential envVar uses a reserved prefix: ${credential.envVar}`
      );
    }
    if (
      credential.authStyle &&
      !OPEN_SHELL_PROVIDER_PROFILE_SURFACE.authStyles.includes(credential.authStyle)
    ) {
      throw new Error(`Unsupported OpenShell auth style: ${credential.authStyle}`);
    }
  }

  if (profile.refresh) {
    if (!OPEN_SHELL_PROVIDER_PROFILE_SURFACE.refreshStrategies.includes(profile.refresh.strategy)) {
      throw new Error(`Unsupported OpenShell refresh strategy: ${profile.refresh.strategy}`);
    }

    for (const key of profile.refresh.materialKeys ?? []) {
      if (!OPEN_SHELL_PROVIDER_PROFILE_SURFACE.refreshMaterialKeys.includes(key)) {
        throw new Error(`Unsupported OpenShell refresh material key: ${key}`);
      }
    }
  }
}

/**
 * Validates rendered OpenShell sandbox policy YAML against the pinned surface.
 *
 * @param policyYaml Generated sandbox policy YAML.
 * @throws Error when required policy sections or enum values are missing.
 */
export function assertOpenShellPolicyConformant(policyYaml: string): void {
  const lines = policyYaml.split(/\r?\n/);
  const text = lines.join('\n');

  for (const key of OPEN_SHELL_POLICY_SURFACE.requiredTopLevelKeys) {
    if (!text.includes(`${key}:`)) {
      throw new Error(`OpenShell policy missing top-level key: ${key}`);
    }
  }
  if (!/^version:\s*1$/m.test(text)) {
    throw new Error('OpenShell policy must declare version: 1.');
  }

  for (const protocol of valuesForIndentedKey(lines, 'protocol')) {
    if (!OPEN_SHELL_POLICY_SURFACE.protocols.includes(protocol)) {
      throw new Error(`Unsupported OpenShell policy protocol: ${protocol}`);
    }
  }
  for (const enforcement of valuesForIndentedKey(lines, 'enforcement')) {
    if (!OPEN_SHELL_POLICY_SURFACE.enforcements.includes(enforcement)) {
      throw new Error(`Unsupported OpenShell policy enforcement: ${enforcement}`);
    }
  }
  for (const access of valuesForIndentedKey(lines, 'access')) {
    if (!OPEN_SHELL_POLICY_SURFACE.accessModes.includes(access)) {
      throw new Error(`Unsupported OpenShell policy access mode: ${access}`);
    }
  }
}

/**
 * Validates that a CLI command vector is part of the pinned OpenShell surface.
 *
 * @param args CLI arguments after the `openshell` binary.
 * @throws Error when the command is outside the pinned surface.
 */
export function assertOpenShellCliCommandConformant(args: readonly string[]): void {
  if (
    !OPEN_SHELL_CLI_SURFACE.commands.some(
      (command) =>
        args.length >= command.length && command.every((segment, index) => args[index] === segment)
    )
  ) {
    throw new Error(`OpenShell CLI command is outside the pinned surface: ${args.join(' ')}`);
  }
}

/**
 * Validates an OpenShell version against the snapshot compatibility range.
 *
 * @param version OpenShell version string.
 * @throws Error when the version is outside the pinned compatibility range.
 */
export function assertCompatibleOpenShellVersion(version: string): void {
  const range = OPEN_SHELL_CLI_SURFACE.compatibleVersionRange;

  if (compareSemver(version, range.min) < 0 || compareSemver(version, range.maxExclusive) >= 0) {
    throw new Error(
      `OpenShell version ${version} is outside the pinned range ${range.min} <= version < ${range.maxExclusive}.`
    );
  }
}

/**
 * Reads one snapshot JSON file from the pinned snapshot directory.
 *
 * @param fileName Snapshot file name.
 * @returns Parsed JSON value.
 */
function readSnapshotJson<T>(fileName: string): T {
  return JSON.parse(readFileSync(new URL(fileName, snapshotRoot), 'utf8')) as T;
}

/**
 * Compares two dotted numeric version strings.
 *
 * @param left Left version.
 * @param right Right version.
 * @returns Negative, zero, or positive comparison result.
 */
function compareSemver(left: string, right: string): number {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);

  for (const index of [0, 1, 2] as const) {
    const delta = leftParts[index] - rightParts[index];

    if (delta !== 0) {
      return delta;
    }
  }

  return 0;
}

/**
 * Parses a three-part numeric version string.
 *
 * @param version Version string.
 * @returns Numeric version tuple.
 * @throws Error when the version is malformed.
 */
function parseVersion(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);

  if (!match) {
    throw new Error(`OpenShell version must be x.y.z: ${version}`);
  }

  const [, major, minor, patch] = match;

  if (major === undefined || minor === undefined || patch === undefined) {
    throw new Error(`OpenShell version must be x.y.z: ${version}`);
  }

  return [Number(major), Number(minor), Number(patch)];
}

/**
 * Returns scalar values for YAML lines ending with the requested key.
 *
 * @param lines YAML lines.
 * @param key YAML key.
 * @returns Scalar string values.
 */
function valuesForIndentedKey(lines: string[], key: string): string[] {
  const pattern = new RegExp(`^\\s+${key}:\\s*(\\S+)\\s*$`);

  return lines.flatMap((line) => {
    const match = pattern.exec(line);

    return match?.[1] ? [match[1]] : [];
  });
}

/**
 * Validates an OpenShell identifier.
 *
 * @param value Identifier value.
 * @param label Human-readable label.
 */
function assertIdentifier(value: string, label: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(value)) {
    throw new Error(`${label} must be lowercase kebab-case: ${value}`);
  }
}
