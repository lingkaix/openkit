import { readFileSync } from 'node:fs';

const snapshotRoot = new URL('../snapshots/2026-07-11/', import.meta.url);
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
export const OPEN_SHELL_PROVIDER_PROFILE_SURFACE =
  providerProfileSurface.openKitProviderProfileMapping;

/** Full upstream provider profile surface recorded from the pinned OpenShell release. */
export const OPEN_SHELL_UPSTREAM_PROVIDER_PROFILE_SURFACE =
  providerProfileSurface.upstreamProviderProfile;

/** Sandbox policy surface pinned by the snapshot. */
export const OPEN_SHELL_POLICY_SURFACE = policySurface.openKitSandboxPolicyMapping;

/** Full upstream sandbox policy surface recorded from the pinned OpenShell release. */
export const OPEN_SHELL_UPSTREAM_POLICY_SURFACE = policySurface.upstreamSandboxPolicy;

/** CLI surface pinned by the snapshot. */
export const OPEN_SHELL_CLI_SURFACE = cliSurface.cli;

/** OpenShell snapshot metadata shape. */
interface OpenShellSnapshotMetadata {
  readonly checksums: Record<string, string>;
  readonly mappingVersion: string;
  readonly requiredGatewayVersion: string;
  readonly refreshedAt: string;
  readonly snapshotId: string;
  readonly sourceBoundary: string;
  readonly sourceCommit: string;
  readonly sourcePaths: string[];
  readonly sourceProject: string;
  readonly sourceRelease: string;
  readonly sourceTag: string;
  readonly sourceVersion: string;
}

/** Provider profile snapshot file shape. */
interface OpenShellProviderProfileSurfaceFile {
  readonly openKitProviderProfileMapping: {
    readonly authStyles: string[];
    readonly categories: string[];
    readonly credentialPlaceholderPrefix: string;
    readonly credentialFields: string[];
    readonly endpointFields: string[];
    readonly requiredFields: string[];
    readonly reservedEnvPrefixPattern: string;
    readonly ruleFields: string[];
    readonly restAllowRuleFields: string[];
    readonly workerInferenceRules: Array<{
      readonly allow: {
        readonly method: string;
        readonly path: string;
      };
    }>;
  };
  readonly schemaVersion: number;
  readonly upstreamProviderProfile: {
    readonly authStyles: string[];
    readonly builtInProfileIds: string[];
    readonly categories: string[];
    readonly genericProviderType: string;
    readonly gatewayRefreshMaterialKeys: string[];
    readonly refreshStrategies: string[];
  };
}

/** Policy snapshot file shape. */
interface OpenShellPolicySurfaceFile {
  readonly openKitSandboxPolicyMapping: {
    readonly accessModes: string[];
    readonly endpointKeys: string[];
    readonly enforcements: string[];
    readonly filesystemPolicyKeys: string[];
    readonly networkPolicyEntryKeys: string[];
    readonly protocols: string[];
    readonly providerLayerPrefix: string;
    readonly providersV2Required: boolean;
    readonly requiredTopLevelKeys: string[];
    readonly restAllowRuleKeys: string[];
    readonly version: number;
  };
  readonly schemaVersion: number;
  readonly upstreamSandboxPolicy: {
    readonly accessModes: string[];
    readonly enforcements: string[];
    readonly protocols: string[];
  };
}

/** CLI snapshot file shape. */
interface OpenShellCliSurfaceFile {
  readonly cli: {
    readonly binary: string;
    readonly commands: string[][];
    readonly requiredVersion: string;
  };
  readonly schemaVersion: number;
}

/** OpenShell 0.0.80 provider credential emitted by OpenKit. */
export interface OpenShellProviderProfileCredentialArtifact {
  /** OpenShell credential injection style. */
  readonly auth_style: string;
  /** Optional human-readable credential purpose. */
  readonly description?: string;
  /** Sandbox environment variables receiving OpenShell placeholders. */
  readonly env_vars: readonly string[];
  /** HTTP header receiving the resolved credential. */
  readonly header_name: string;
  /** Stable credential name within the profile. */
  readonly name: string;
  /** Empty for header-auth credentials after OpenShell normalization. */
  readonly query_param: string;
  /** Whether provider creation requires the credential. */
  readonly required: boolean;
}

/** Exact REST allow rule emitted inside an OpenShell 0.0.80 provider endpoint. */
export interface OpenShellProviderProfileAllowRuleArtifact {
  /** Exact request matcher allowed by the provider-composed policy layer. */
  readonly allow: {
    /** Exact HTTP method. */
    readonly method: string;
    /** Exact absolute HTTP path. */
    readonly path: string;
  };
}

/** OpenShell 0.0.80 provider endpoint emitted by OpenKit. */
export interface OpenShellProviderProfileEndpointArtifact {
  /** Enforcement mode applied by the OpenShell network proxy. */
  readonly enforcement: string;
  /** Relay or provider host visible from the sandbox network. */
  readonly host: string;
  /** Relay or provider TCP port. */
  readonly port: number;
  /** OpenShell application protocol. */
  readonly protocol: string;
  /** Exact request rules retained when OpenShell composes the provider policy layer. */
  readonly rules: readonly OpenShellProviderProfileAllowRuleArtifact[];
}

/** Exact OpenShell 0.0.80 provider profile artifact emitted by OpenKit. */
export interface OpenShellProviderProfileArtifact {
  /** Executable paths authorized to use this provider. */
  readonly binaries: readonly string[];
  /** Generated provider profile id. */
  readonly id: string;
  /** Provider profile category. */
  readonly category: string;
  /** Credential declarations consumed by OpenShell. */
  readonly credentials: readonly OpenShellProviderProfileCredentialArtifact[];
  /** Optional human-readable profile purpose. */
  readonly description?: string;
  /** Human-readable display name using the upstream field name. */
  readonly display_name: string;
  /** Network endpoints contributed by the provider policy layer. */
  readonly endpoints: readonly OpenShellProviderProfileEndpointArtifact[];
  /** Whether OpenShell may use this profile as its own inference provider. */
  readonly inference_capable: boolean;
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

  if (OPEN_SHELL_UPSTREAM_PROVIDER_PROFILE_SURFACE.builtInProfileIds.includes(profile.id)) {
    throw new Error(`OpenShell provider profile id is reserved: ${profile.id}`);
  }
  if (!OPEN_SHELL_PROVIDER_PROFILE_SURFACE.categories.includes(profile.category)) {
    throw new Error(`Unsupported OpenShell provider profile category: ${profile.category}`);
  }
  if (!profile.display_name.trim()) {
    throw new Error('OpenShell provider profile display_name is required.');
  }
  if (profile.credentials.length === 0) {
    throw new Error('OpenShell provider profile requires at least one credential.');
  }
  for (const credential of profile.credentials) {
    assertProviderCredentialName(credential.name);
    if (credential.env_vars.length === 0) {
      throw new Error(
        `OpenShell provider credential ${credential.name} requires at least one env_var.`
      );
    }
    for (const envVar of credential.env_vars) {
      if (!envVar.trim()) {
        throw new Error(`OpenShell provider credential ${credential.name} env_var is required.`);
      }
      if (new RegExp(OPEN_SHELL_PROVIDER_PROFILE_SURFACE.reservedEnvPrefixPattern).test(envVar)) {
        throw new Error(`OpenShell provider credential env_var uses a reserved prefix: ${envVar}`);
      }
    }
    if (!OPEN_SHELL_PROVIDER_PROFILE_SURFACE.authStyles.includes(credential.auth_style)) {
      throw new Error(`Unsupported OpenShell auth style: ${credential.auth_style}`);
    }
    if (!credential.header_name.trim()) {
      throw new Error(`OpenShell provider credential ${credential.name} header_name is required.`);
    }
    if (credential.query_param !== '') {
      throw new Error(
        `OpenShell provider credential ${credential.name} query_param must be empty for header auth.`
      );
    }
  }
  if (profile.endpoints.length === 0) {
    throw new Error('OpenShell provider profile requires at least one endpoint.');
  }
  for (const endpoint of profile.endpoints) {
    if (!endpoint.host.trim()) {
      throw new Error('OpenShell provider endpoint host is required.');
    }
    if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65_535) {
      throw new Error(`Invalid OpenShell provider endpoint port: ${endpoint.port}`);
    }
    if (!OPEN_SHELL_POLICY_SURFACE.protocols.includes(endpoint.protocol)) {
      throw new Error(`Unsupported OpenShell provider endpoint protocol: ${endpoint.protocol}`);
    }
    if (!OPEN_SHELL_POLICY_SURFACE.enforcements.includes(endpoint.enforcement)) {
      throw new Error(
        `Unsupported OpenShell provider endpoint enforcement: ${endpoint.enforcement}`
      );
    }
    if ('access' in endpoint) {
      throw new Error(
        'OpenShell worker inference provider endpoint must not declare broad access.'
      );
    }
    const exactRules = endpoint.rules
      .map((rule) => `${rule.allow.method} ${rule.allow.path}`)
      .sort();
    const requiredRules = OPEN_SHELL_PROVIDER_PROFILE_SURFACE.workerInferenceRules
      .map((rule) => `${rule.allow.method} ${rule.allow.path}`)
      .sort();
    if (
      endpoint.rules.length !== 2 ||
      endpoint.rules.some(
        (rule) =>
          Object.keys(rule).length !== 1 ||
          Object.keys(rule.allow).sort().join(',') !== 'method,path'
      ) ||
      exactRules.join('\n') !== requiredRules.join('\n')
    ) {
      throw new Error(
        'OpenShell provider endpoint must contain the exact worker inference POST rules.'
      );
    }
  }
  if (profile.binaries.length === 0 || profile.binaries.some((binary) => !binary.startsWith('/'))) {
    throw new Error('OpenShell provider profile binaries must contain absolute paths.');
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
 * Validates an OpenShell version against the exact snapshot requirement.
 *
 * @param version OpenShell version string.
 * @throws Error when the version differs from the pinned version.
 */
export function assertRequiredOpenShellVersion(version: string): void {
  if (version !== OPEN_SHELL_CLI_SURFACE.requiredVersion) {
    throw new Error(
      `OpenShell requires exactly ${OPEN_SHELL_CLI_SURFACE.requiredVersion}; got ${version}.`
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

/**
 * Validates the upstream snake-case provider credential name shape.
 *
 * @param value Provider credential name.
 */
function assertProviderCredentialName(value: string): void {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) {
    throw new Error(`OpenShell provider credential name must be lowercase snake-case: ${value}`);
  }
}
