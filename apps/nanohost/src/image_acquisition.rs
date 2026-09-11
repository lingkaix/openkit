//! Closed NanoHost-local image acquisition and bounded build execution.

#![allow(dead_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use std::pin::Pin;
use std::process::{Child, Command, Stdio};
use std::task::{Context, Poll};
use std::thread;
use std::time::{Duration, Instant};

use oci_client::client::{ClientConfig, ClientProtocol};
use oci_client::manifest::{
    IMAGE_MANIFEST_MEDIA_TYPE, OCI_IMAGE_MEDIA_TYPE, OciImageManifest, OciManifest,
};
use oci_client::secrets::RegistryAuth;
use oci_client::{Client, Reference, RegistryOperation};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWrite;

use crate::image_store::{IMAGE_ARCHIVE_MAX_BYTES, ImageStore, StoreError, StoreLineage};

/// Hard build wall-clock ceiling.
pub const BUILD_MAX_TIME: Duration = Duration::from_secs(30 * 60);

/// Hard build OCI-output ceiling.
pub const BUILD_MAX_OUTPUT_BYTES: u64 = 20 * 1024 * 1024 * 1024;

/// Hard V1 ceiling for the independently carried inline Dockerfile bytes.
const DOCKERFILE_INPUT_MAX_BYTES: usize = 256 * 1024 * 1024;

/// Hard V1 ceiling for one produced OCI manifest's layer count.
pub const BUILD_MAX_LAYERS: u32 = 128;

/// Sole V1 build-context reference accepted by NanoHost.
pub const EMPTY_BUILD_CONTEXT_REF: &str = "build-context://empty/v1";

/// SHA-256 of the sole V1 context's zero-entry empty-byte sequence.
pub const EMPTY_BUILD_CONTEXT_DIGEST: &str =
    "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/// Hard wall-clock bound for one anonymous public-registry acquisition.
const REGISTRY_MAX_TIME: Duration = Duration::from_secs(15 * 60);

/// Hard in-memory raw-manifest bound before descriptor parsing.
const OCI_DOCUMENT_MAX_BYTES: usize = 512 * 1024;

/// Maximum transfer and hashing chunk retained in memory.
const ARCHIVE_CHUNK_BYTES: usize = 64 * 1024;

/// Fixed private Docker repository reserved for retained-parent resolver aliases.
const RETAINED_PARENT_ALIAS_REPOSITORY: &str = "openkit.invalid/retained-parent";

/// The only callers authorized to initiate acquisition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcquisitionTrigger {
    /// Explicit server-admin installation or maintenance action.
    DeploymentMaintenance,
    /// One already-authorized attempt carried by the control session.
    AuthorizedAttempt,
}

impl AcquisitionTrigger {
    /// Parses the closed acquisition trigger vocabulary.
    ///
    /// # Errors
    ///
    /// Returns an error for sandbox, worker, Gateway, backend, readiness, or
    /// any other caller class.
    pub fn parse(value: &str) -> Result<Self, AcquisitionError> {
        match value {
            "deployment-maintenance" => Ok(Self::DeploymentMaintenance),
            "authorized-attempt" => Ok(Self::AuthorizedAttempt),
            _ => Err(AcquisitionError::UnauthorizedTrigger),
        }
    }
}

/// Fail-closed acquisition and build error classes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcquisitionError {
    /// The caller is outside the two accepted acquisition classes.
    UnauthorizedTrigger,
    /// A registry reference is mutable, malformed, private, or undeclared.
    InvalidRegistryReference,
    /// Returned content does not match the exact requested digest.
    DigestMismatch,
    /// A build definition or owned path is malformed or exceeds its bounds.
    InvalidBuildDefinition,
    /// The private builder cannot prove strict proxy-policy and OCI capability.
    UnsupportedBuildCapability,
    /// A direct backend command failed or exceeded its bound.
    Backend,
    /// An OCI result is malformed, oversized, over-layered, or unverifiable.
    InvalidOciResult,
    /// A private filesystem operation failed.
    Io,
}

impl From<io::Error> for AcquisitionError {
    fn from(_: io::Error) -> Self {
        Self::Io
    }
}

/// One exact image-effect input admitted from the outer session.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ImageEffectInput {
    /// Exact immutable public-registry reference.
    Reference(String),
    /// Immutable build-definition lineage carried without build bytes.
    Build {
        context_digest: String,
        dockerfile_digest: String,
        arguments_digest: String,
    },
}

/// Bounded image-effect request that carries reference or build lineage, never image bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageEffectRequest {
    request_id: String,
    input: ImageEffectInput,
}

impl ImageEffectRequest {
    /// Creates one exact-reference acquisition request.
    pub fn reference(request_id: &str, reference: &str) -> Self {
        Self {
            request_id: request_id.to_string(),
            input: ImageEffectInput::Reference(reference.to_string()),
        }
    }

    /// Creates one immutable build-lineage request.
    pub fn build(
        request_id: &str,
        context_digest: &str,
        dockerfile_digest: &str,
        arguments_digest: &str,
    ) -> Self {
        Self {
            request_id: request_id.to_string(),
            input: ImageEffectInput::Build {
                context_digest: context_digest.to_string(),
                dockerfile_digest: dockerfile_digest.to_string(),
                arguments_digest: arguments_digest.to_string(),
            },
        }
    }

    /// Validates exact reference identity or complete immutable build lineage.
    ///
    /// # Errors
    ///
    /// Rejects empty request identity, mutable references, and incomplete lineage.
    pub fn validate(&self) -> Result<(), AcquisitionError> {
        if self.request_id.is_empty() || self.request_id.contains(['\r', '\n', '\0']) {
            return Err(AcquisitionError::InvalidBuildDefinition);
        }
        match &self.input {
            ImageEffectInput::Reference(reference) => {
                if validate_digest(reference).is_ok() {
                    return Ok(());
                }
                let parsed = Reference::try_from(reference.as_str())
                    .map_err(|_| AcquisitionError::InvalidRegistryReference)?;
                let digest = parsed
                    .digest()
                    .ok_or(AcquisitionError::InvalidRegistryReference)?;
                if parsed.tag().is_some() {
                    return Err(AcquisitionError::InvalidRegistryReference);
                }
                validate_digest(digest).map_err(|_| AcquisitionError::InvalidRegistryReference)
            }
            ImageEffectInput::Build {
                context_digest,
                dockerfile_digest,
                arguments_digest,
            } => {
                if valid_effect_lineage(context_digest)
                    && valid_effect_lineage(dockerfile_digest)
                    && valid_effect_lineage(arguments_digest)
                {
                    Ok(())
                } else {
                    Err(AcquisitionError::InvalidBuildDefinition)
                }
            }
        }
    }

    /// Returns the exact request identity carried by this image effect.
    pub fn request_id(&self) -> &str {
        &self.request_id
    }
}

/// Result evidence for one image effect, containing only identity and resulting digest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageEffectEvidence {
    request_id: String,
    resulting_digest: String,
}

impl ImageEffectEvidence {
    /// Creates non-authoritative digest evidence for one exact request.
    pub fn new(request_id: &str, resulting_digest: &str) -> Self {
        Self {
            request_id: request_id.to_string(),
            resulting_digest: resulting_digest.to_string(),
        }
    }

    /// Validates request identity and digest-shaped result evidence.
    ///
    /// # Errors
    ///
    /// Rejects empty request identity and mutable or non-digest result labels.
    pub fn validate(&self) -> Result<(), AcquisitionError> {
        if self.request_id.is_empty() || !valid_effect_lineage(&self.resulting_digest) {
            return Err(AcquisitionError::InvalidOciResult);
        }
        Ok(())
    }

    /// Returns the exact request identity for result correlation.
    pub fn request_id(&self) -> &str {
        &self.request_id
    }

    /// Returns the resulting content digest without image bytes.
    pub fn resulting_digest(&self) -> &str {
        &self.resulting_digest
    }

    /// Verifies exact request/result correlation.
    ///
    /// # Errors
    ///
    /// Rejects evidence produced for another request identity.
    pub fn validate_result_identity(&self, request_id: &str) -> Result<(), AcquisitionError> {
        if self.request_id != request_id {
            return Err(AcquisitionError::InvalidOciResult);
        }
        self.validate()
    }
}

/// Returns whether bounded image-effect lineage carries a non-empty digest label.
fn valid_effect_lineage(value: &str) -> bool {
    value
        .strip_prefix("sha256:")
        .is_some_and(|digest| !digest.is_empty() && !digest.contains(['\r', '\n', '\0']))
}

/// Validated exact public-registry acquisition request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryAcquisition {
    reference: Reference,
    digest: String,
}

impl RegistryAcquisition {
    /// Validates one exact Docker Hub or GHCR digest reference.
    ///
    /// # Errors
    ///
    /// Rejects mutable, private, malformed, or undeclared references.
    pub fn validate(
        _trigger: AcquisitionTrigger,
        reference: &str,
        declared_registries: &BTreeSet<String>,
    ) -> Result<Self, AcquisitionError> {
        let parsed = Reference::try_from(reference)
            .map_err(|_| AcquisitionError::InvalidRegistryReference)?;
        let digest = parsed
            .digest()
            .ok_or(AcquisitionError::InvalidRegistryReference)?
            .to_string();
        validate_digest(&digest)?;
        let host = parsed.registry();
        if reference.contains(['\r', '\n', '\0', '?', '#'])
            || parsed.tag().is_some()
            || !matches!(host, "docker.io" | "ghcr.io")
            || !declared_registries.contains(host)
            || declared_registries
                .iter()
                .any(|registry| !matches!(registry.as_str(), "docker.io" | "ghcr.io"))
        {
            return Err(AcquisitionError::InvalidRegistryReference);
        }
        Ok(Self {
            reference: parsed,
            digest,
        })
    }

    /// Re-verifies returned registry bytes against the exact requested digest.
    ///
    /// # Errors
    ///
    /// Returns [`AcquisitionError::DigestMismatch`] on any mismatch.
    pub fn verify_content(&self, content: &[u8]) -> Result<String, AcquisitionError> {
        let actual = format!("sha256:{:x}", Sha256::digest(content));
        if actual == self.digest {
            Ok(actual)
        } else {
            Err(AcquisitionError::DigestMismatch)
        }
    }

    /// Retrieves one anonymous exact-digest image graph and admits its verified OCI archive.
    ///
    /// # Errors
    ///
    /// Fails closed on client construction, authentication, retrieval, descriptor,
    /// bound, staging, archive, cleanup, or store-admission failure.
    pub async fn acquire(
        &self,
        staging_root: &Path,
        store: &ImageStore,
        acquired_at: u64,
    ) -> Result<String, AcquisitionError> {
        match store.read_verified(&self.digest) {
            Ok(_) => return Ok(self.digest.clone()),
            Err(StoreError::Missing) => {}
            Err(_) => return Err(AcquisitionError::InvalidOciResult),
        }
        validate_owned_path(staging_root)?;
        if staging_root.exists() {
            return Err(AcquisitionError::InvalidRegistryReference);
        }
        let archive_result = tokio::time::timeout(
            REGISTRY_MAX_TIME,
            self.retrieve_registry_archive(staging_root),
        )
        .await
        .map_err(|_| AcquisitionError::Backend)
        .and_then(|result| result);
        let cleanup_result = match fs::remove_dir_all(staging_root) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(AcquisitionError::Io),
        };
        let archive = archive_result?;
        store
            .admit_oci_file(
                &self.digest,
                archive,
                StoreLineage::Registry(self.reference.whole()),
                acquired_at,
            )
            .map_err(|_| AcquisitionError::InvalidOciResult)?;
        cleanup_result?;
        Ok(self.digest.clone())
    }

    /// Retrieves and stages the exact graph without touching the store or backend.
    async fn retrieve_registry_archive(
        &self,
        staging_root: &Path,
    ) -> Result<File, AcquisitionError> {
        let client = Client::try_from(ClientConfig {
            protocol: ClientProtocol::Https,
            accept_invalid_certificates: false,
            platform_resolver: None,
            max_concurrent_download: 1,
            connect_timeout: Some(Duration::from_secs(10)),
            read_timeout: Some(REGISTRY_MAX_TIME),
            ..Default::default()
        })
        .map_err(|_| AcquisitionError::Backend)?;
        let bearer_token = client
            .auth(
                &self.reference,
                &RegistryAuth::Anonymous,
                RegistryOperation::Pull,
            )
            .await
            .map_err(|_| AcquisitionError::Backend)?;
        let raw_manifest = pull_manifest_bounded(&self.reference, bearer_token.as_deref()).await?;
        self.verify_content(&raw_manifest)?;
        let manifest = parse_image_manifest(&raw_manifest)?;
        let descriptor_sizes =
            prepare_registry_layout(self, &raw_manifest, &manifest, staging_root)?;
        let mut downloaded = BTreeSet::new();
        for descriptor in std::iter::once(&manifest.config).chain(manifest.layers.iter()) {
            if !downloaded.insert(descriptor.digest.clone()) {
                continue;
            }
            let stem = digest_hex(&descriptor.digest)?;
            let final_path = staging_root.join("blobs/sha256").join(stem);
            let partial_path = staging_root
                .join("blobs/sha256")
                .join(format!(".{stem}.part"));
            let file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(&partial_path)?;
            let declared_size = *descriptor_sizes
                .get(&descriptor.digest)
                .ok_or(AcquisitionError::InvalidOciResult)?;
            let mut writer = BoundedBlobWriter::new(tokio::fs::File::from_std(file), declared_size);
            client
                .pull_blob(&self.reference, descriptor, &mut writer)
                .await
                .map_err(|_| AcquisitionError::Backend)?;
            writer.sync_all().await?;
            if writer.written() != declared_size {
                return Err(AcquisitionError::InvalidOciResult);
            }
            fs::rename(partial_path, final_path)?;
        }
        archive_registry_layout(staging_root, &self.digest, &descriptor_sizes)
    }
}

/// Retrieves one raw manifest with a pre-allocation and running byte ceiling.
async fn pull_manifest_bounded(
    reference: &Reference,
    bearer_token: Option<&str>,
) -> Result<Vec<u8>, AcquisitionError> {
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(REGISTRY_MAX_TIME)
        .timeout(REGISTRY_MAX_TIME)
        .build()
        .map_err(|_| AcquisitionError::Backend)?;
    let digest = reference
        .digest()
        .ok_or(AcquisitionError::InvalidRegistryReference)?;
    let url = format!(
        "https://{}/v2/{}/manifests/{digest}",
        reference.resolve_registry(),
        reference.repository(),
    );
    let mut request = client.get(url).header(
        reqwest::header::ACCEPT,
        format!("{OCI_IMAGE_MEDIA_TYPE}, {IMAGE_MANIFEST_MEDIA_TYPE}"),
    );
    if let Some(token) = bearer_token {
        request = request.bearer_auth(token);
    }
    let mut response = request
        .send()
        .await
        .map_err(|_| AcquisitionError::Backend)?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(AcquisitionError::Backend);
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .ok_or(AcquisitionError::InvalidOciResult)?;
    if !matches!(
        content_type,
        OCI_IMAGE_MEDIA_TYPE | IMAGE_MANIFEST_MEDIA_TYPE
    ) {
        return Err(AcquisitionError::InvalidOciResult);
    }
    if let Some(length) = response.content_length()
        && length > OCI_DOCUMENT_MAX_BYTES as u64
    {
        return Err(AcquisitionError::InvalidOciResult);
    }
    if let Some(header_digest) = response.headers().get("docker-content-digest") {
        let header_digest = header_digest
            .to_str()
            .map_err(|_| AcquisitionError::InvalidOciResult)?;
        if header_digest != digest {
            return Err(AcquisitionError::DigestMismatch);
        }
    }
    let mut raw_manifest = Vec::with_capacity(OCI_DOCUMENT_MAX_BYTES);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| AcquisitionError::Backend)?
    {
        extend_manifest_bounded(&mut raw_manifest, &chunk)?;
    }
    if raw_manifest.is_empty() || format!("sha256:{:x}", Sha256::digest(&raw_manifest)) != digest {
        return Err(AcquisitionError::DigestMismatch);
    }
    Ok(raw_manifest)
}

fn extend_manifest_bounded(
    manifest: &mut Vec<u8>,
    response_chunk: &[u8],
) -> Result<(), AcquisitionError> {
    for chunk in response_chunk.chunks(ARCHIVE_CHUNK_BYTES) {
        if manifest
            .len()
            .checked_add(chunk.len())
            .is_none_or(|length| length > OCI_DOCUMENT_MAX_BYTES)
        {
            return Err(AcquisitionError::InvalidOciResult);
        }
        manifest.extend_from_slice(chunk);
    }
    Ok(())
}

/// Stages already retrieved manifest and blob bytes as one minimal verified OCI layout.
///
/// # Errors
///
/// Rejects non-image manifests, missing or extra blobs, digest or size mismatch,
/// unsafe paths, bounds overflow, and every partial filesystem result. A failure
/// removes the staging root created by this call.
pub(crate) fn stage_registry_layout(
    acquisition: &RegistryAcquisition,
    raw_manifest: &[u8],
    blobs: &[(&str, &[u8])],
    staging_root: &Path,
) -> Result<(), AcquisitionError> {
    validate_owned_path(staging_root)?;
    if staging_root.exists() {
        return Err(AcquisitionError::InvalidOciResult);
    }
    let result = (|| {
        let manifest = parse_image_manifest(raw_manifest)?;
        let expected = prepare_registry_layout(acquisition, raw_manifest, &manifest, staging_root)?;
        let mut supplied = BTreeMap::new();
        for (digest, bytes) in blobs {
            if supplied.insert(*digest, *bytes).is_some() {
                return Err(AcquisitionError::InvalidOciResult);
            }
        }
        if supplied.len() != expected.len() {
            return Err(AcquisitionError::InvalidOciResult);
        }
        for (digest, declared_size) in expected {
            let bytes = supplied
                .get(digest.as_str())
                .ok_or(AcquisitionError::InvalidOciResult)?;
            if bytes.len() as u64 != declared_size
                || format!("sha256:{:x}", Sha256::digest(bytes)) != digest
            {
                return Err(AcquisitionError::InvalidOciResult);
            }
            write_new_private_file(
                &staging_root.join("blobs/sha256").join(digest_hex(&digest)?),
                bytes,
            )?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(staging_root);
    }
    result
}

/// Parses and restricts raw registry bytes to one concrete image manifest.
fn parse_image_manifest(raw_manifest: &[u8]) -> Result<OciImageManifest, AcquisitionError> {
    if raw_manifest.is_empty() || raw_manifest.len() > OCI_DOCUMENT_MAX_BYTES {
        return Err(AcquisitionError::InvalidOciResult);
    }
    let manifest: OciManifest =
        serde_json::from_slice(raw_manifest).map_err(|_| AcquisitionError::InvalidOciResult)?;
    let OciManifest::Image(manifest) = manifest else {
        return Err(AcquisitionError::InvalidOciResult);
    };
    if manifest.schema_version != 2
        || !matches!(
            manifest.media_type.as_deref(),
            Some(OCI_IMAGE_MEDIA_TYPE | IMAGE_MANIFEST_MEDIA_TYPE)
        )
        || manifest.artifact_type.is_some()
        || manifest.subject.is_some()
    {
        return Err(AcquisitionError::InvalidOciResult);
    }
    Ok(manifest)
}

/// Creates the fixed metadata and raw-manifest portion of one fresh OCI layout.
fn prepare_registry_layout(
    acquisition: &RegistryAcquisition,
    raw_manifest: &[u8],
    manifest: &OciImageManifest,
    staging_root: &Path,
) -> Result<BTreeMap<String, u64>, AcquisitionError> {
    acquisition.verify_content(raw_manifest)?;
    let descriptor_sizes = validated_descriptor_sizes(manifest, raw_manifest.len() as u64)?;
    if descriptor_sizes.contains_key(&acquisition.digest) {
        return Err(AcquisitionError::InvalidOciResult);
    }
    DirBuilder::new().mode(0o700).create(staging_root)?;
    create_private_dir(&staging_root.join("blobs"))?;
    create_private_dir(&staging_root.join("blobs/sha256"))?;
    write_new_private_file(
        &staging_root.join("oci-layout"),
        b"{\"imageLayoutVersion\":\"1.0.0\"}\n",
    )?;
    let index = format!(
        "{{\"schemaVersion\":2,\"manifests\":[{{\"mediaType\":{},\"digest\":{},\"size\":{}}}]}}\n",
        serde_json::to_string(
            manifest
                .media_type
                .as_deref()
                .ok_or(AcquisitionError::InvalidOciResult)?
        )
        .map_err(|_| AcquisitionError::InvalidOciResult)?,
        serde_json::to_string(&acquisition.digest)
            .map_err(|_| AcquisitionError::InvalidOciResult)?,
        raw_manifest.len()
    );
    write_new_private_file(&staging_root.join("index.json"), index.as_bytes())?;
    write_new_private_file(
        &staging_root
            .join("blobs/sha256")
            .join(digest_hex(&acquisition.digest)?),
        raw_manifest,
    )?;
    Ok(descriptor_sizes)
}

/// Validates every unique config and layer descriptor and the whole graph bound.
fn validated_descriptor_sizes(
    manifest: &OciImageManifest,
    manifest_size: u64,
) -> Result<BTreeMap<String, u64>, AcquisitionError> {
    if manifest.layers.len() > BUILD_MAX_LAYERS as usize
        || manifest.config.size < 0
        || manifest.config.size as usize > OCI_DOCUMENT_MAX_BYTES
    {
        return Err(AcquisitionError::InvalidOciResult);
    }
    let mut total = manifest_size;
    let mut descriptors = BTreeMap::new();
    for descriptor in std::iter::once(&manifest.config).chain(manifest.layers.iter()) {
        if descriptor.urls.is_some() || descriptor.size < 0 {
            return Err(AcquisitionError::InvalidOciResult);
        }
        validate_digest(&descriptor.digest).map_err(|_| AcquisitionError::InvalidOciResult)?;
        let size = descriptor.size as u64;
        if let Some(existing) = descriptors.insert(descriptor.digest.clone(), size) {
            if existing != size {
                return Err(AcquisitionError::InvalidOciResult);
            }
            continue;
        }
        total = total
            .checked_add(size)
            .ok_or(AcquisitionError::InvalidOciResult)?;
        if total > IMAGE_ARCHIVE_MAX_BYTES {
            return Err(AcquisitionError::InvalidOciResult);
        }
    }
    Ok(descriptors)
}

/// Returns the canonical hex path component for one SHA-256 digest.
fn digest_hex(digest: &str) -> Result<&str, AcquisitionError> {
    validate_digest(digest).map_err(|_| AcquisitionError::InvalidOciResult)?;
    digest
        .strip_prefix("sha256:")
        .ok_or(AcquisitionError::InvalidOciResult)
}

/// Writes one new private staging file without following an existing path.
fn write_new_private_file(path: &Path, contents: &[u8]) -> Result<(), AcquisitionError> {
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(contents)?;
    file.sync_all()?;
    Ok(())
}

/// Async file writer that rejects a registry response beyond its descriptor size.
struct BoundedBlobWriter {
    file: tokio::fs::File,
    written: u64,
    limit: u64,
}

impl BoundedBlobWriter {
    /// Wraps one fresh partial blob file with its exact descriptor ceiling.
    fn new(file: tokio::fs::File, limit: u64) -> Self {
        Self {
            file,
            written: 0,
            limit,
        }
    }

    /// Returns the successfully written byte count.
    fn written(&self) -> u64 {
        self.written
    }

    /// Flushes blob bytes and metadata to stable storage.
    async fn sync_all(&self) -> Result<(), AcquisitionError> {
        self.file.sync_all().await.map_err(Into::into)
    }
}

impl AsyncWrite for BoundedBlobWriter {
    /// Writes one response chunk without crossing the descriptor ceiling.
    fn poll_write(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        let remaining = self.limit.saturating_sub(self.written);
        if remaining == 0 && !buffer.is_empty() {
            return Poll::Ready(Err(io::Error::other(
                "registry blob exceeded descriptor size",
            )));
        }
        let chunk = buffer
            .len()
            .min(ARCHIVE_CHUNK_BYTES)
            .min(usize::try_from(remaining).unwrap_or(usize::MAX));
        match Pin::new(&mut self.file).poll_write(context, &buffer[..chunk]) {
            Poll::Ready(Ok(written)) => {
                self.written += written as u64;
                Poll::Ready(Ok(written))
            }
            result => result,
        }
    }

    /// Flushes the underlying partial blob file.
    fn poll_flush(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.file).poll_flush(context)
    }

    /// Shuts down the underlying partial blob file.
    fn poll_shutdown(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.file).poll_shutdown(context)
    }
}

/// Accepted immutable build-definition projection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildDefinition {
    /// Exact singleton context reference preserved from the resolved AEP.
    pub context_ref: String,
    /// Digest of the separately accepted local build context.
    pub context_digest: String,
    /// Dockerfile data consumed only by the backend build operation.
    pub dockerfile: String,
    /// Declared non-secret build arguments.
    pub arguments: Vec<(String, String)>,
    /// Exact hostname or HTTPS endpoint build-only grants.
    pub egress_grants: BTreeSet<String>,
    /// Declared wall-clock bound.
    pub time_limit: Duration,
    /// Declared OCI output-size bound.
    pub output_limit_bytes: u64,
    /// Declared maximum manifest layer count.
    pub layer_limit: u32,
}

impl BuildDefinition {
    /// Returns deterministic non-secret build-definition lineage.
    pub fn lineage(&self) -> String {
        let mut hasher = Sha256::new();
        hash_field(&mut hasher, self.context_ref.as_bytes());
        hash_field(&mut hasher, self.context_digest.as_bytes());
        hash_field(&mut hasher, self.dockerfile.as_bytes());
        for (key, value) in &self.arguments {
            hash_field(&mut hasher, key.as_bytes());
            hash_field(&mut hasher, value.as_bytes());
        }
        for grant in &self.egress_grants {
            hash_field(&mut hasher, grant.as_bytes());
        }
        hash_field(&mut hasher, &self.time_limit.as_secs().to_be_bytes());
        hash_field(&mut hasher, &self.output_limit_bytes.to_be_bytes());
        hash_field(&mut hasher, &self.layer_limit.to_be_bytes());
        format!("sha256:{:x}", hasher.finalize())
    }
}

/// Exact private-builder capability snapshot proved before a build effect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildCapabilities {
    /// Embedded BuildKit semantic version.
    pub buildkit_version: String,
    /// Buildx semantic version.
    pub buildx_version: String,
    /// Whether the versioned strict policy path supplies `exec.proxy`.
    pub exec_proxy: bool,
}

impl BuildCapabilities {
    /// Proves the minimum versioned strict proxy-network tuple.
    ///
    /// # Errors
    ///
    /// Fails before build execution when any required capability is absent.
    pub fn preflight(&self) -> Result<(), AcquisitionError> {
        if version_at_least(&self.buildkit_version, (0, 31, 0))
            && version_at_least(&self.buildx_version, (0, 35, 0))
            && self.exec_proxy
        {
            Ok(())
        } else {
            Err(AcquisitionError::UnsupportedBuildCapability)
        }
    }

    /// Probes the exact epoch-private Docker driver without selecting another builder.
    ///
    /// # Errors
    ///
    /// Returns a fail-closed capability error for unavailable or ambiguous output.
    pub fn probe(
        docker_socket: &Path,
        build_root: &Path,
        deadline: Instant,
    ) -> Result<Self, AcquisitionError> {
        validate_owned_path(docker_socket)?;
        let mut buildx = Command::new("/usr/bin/docker");
        buildx
            .args(["buildx", "version"])
            .env("DOCKER_HOST", format!("unix://{}", docker_socket.display()))
            .env_remove("BUILDX_BUILDER");
        let buildx_output = bounded_command_output(
            &mut buildx,
            &build_root.join("buildx-version.txt"),
            deadline,
        )?;
        let buildx_version =
            first_semver(&buildx_output).ok_or(AcquisitionError::UnsupportedBuildCapability)?;

        let mut inspect = Command::new("/usr/bin/docker");
        inspect
            .args(["buildx", "inspect", "--bootstrap"])
            .env("DOCKER_HOST", format!("unix://{}", docker_socket.display()))
            .env_remove("BUILDX_BUILDER");
        let inspect_output = bounded_command_output(
            &mut inspect,
            &build_root.join("buildx-inspect.txt"),
            deadline,
        )?;
        let buildkit_version = inspect_output
            .lines()
            .find_map(|line| line.trim().strip_prefix("BuildKit version:").map(str::trim))
            .and_then(first_semver)
            .or_else(|| {
                inspect_output
                    .lines()
                    .find_map(|line| line.trim().strip_prefix("Version:").map(str::trim))
                    .and_then(first_semver)
            })
            .ok_or(AcquisitionError::UnsupportedBuildCapability)?;
        let capabilities = Self {
            exec_proxy: version_at_least(&buildkit_version, (0, 31, 0)),
            buildkit_version,
            buildx_version,
        };
        capabilities.preflight()?;
        Ok(capabilities)
    }
}

/// Direct, fixed Buildx execution plan for one accepted build definition.
#[derive(Debug, Clone)]
pub struct BuildPlan {
    definition: BuildDefinition,
    from_references: BTreeSet<ExactFromReference>,
    program: PathBuf,
    env: Vec<(String, String)>,
    args: Vec<String>,
    policy_contents: String,
    allowed_egress: BTreeSet<String>,
    build_root: PathBuf,
    docker_socket: PathBuf,
}

impl BuildPlan {
    /// Validates and compiles one fixed private-backend build plan.
    ///
    /// # Errors
    ///
    /// Rejects unbounded, secret-bearing, host-authority-widening, or unsafe input.
    pub fn validate(
        definition: BuildDefinition,
        declared_registries: &BTreeSet<String>,
        docker_socket: &Path,
        build_root: &Path,
    ) -> Result<Self, AcquisitionError> {
        validate_build_definition(&definition, declared_registries)?;
        validate_owned_path(docker_socket)?;
        validate_owned_path(build_root)?;
        let allowed_egress = declared_registries
            .iter()
            .chain(definition.egress_grants.iter())
            .cloned()
            .collect::<BTreeSet<_>>();
        let from_references = exact_from_references(&definition.dockerfile, declared_registries)?;
        let image_refs = from_references
            .iter()
            .map(|reference| reference.canonical.clone())
            .collect();
        let retained_parent_aliases = from_references
            .iter()
            .map(|reference| {
                Ok((
                    retained_parent_alias(&reference.digest)?,
                    reference.digest.clone(),
                ))
            })
            .collect::<Result<BTreeMap<_, _>, AcquisitionError>>()?;
        let policy_contents = render_policy(
            declared_registries,
            &definition.egress_grants,
            &image_refs,
            &retained_parent_aliases,
        );
        let context_root = build_root.join("context");
        let output_path = build_root.join("result.oci.tar");
        let metadata_path = build_root.join("metadata.json");
        let mut args = vec![
            "buildx".into(),
            "build".into(),
            "--policy".into(),
            "filename=cwd://policy.rego,reset=true,strict=true".into(),
            "--network".into(),
            "default".into(),
            "--output".into(),
            format!("type=oci,dest={}", output_path.display()),
            "--metadata-file".into(),
            metadata_path.display().to_string(),
            "--progress".into(),
            "plain".into(),
            "--file".into(),
            build_root.join("Dockerfile").display().to_string(),
        ];
        for (key, value) in &definition.arguments {
            args.push("--build-arg".into());
            args.push(format!("{key}={value}"));
        }
        args.push(context_root.display().to_string());
        Ok(Self {
            definition,
            from_references,
            program: PathBuf::from("/usr/bin/docker"),
            env: vec![(
                "DOCKER_HOST".into(),
                format!("unix://{}", docker_socket.display()),
            )],
            args,
            policy_contents,
            allowed_egress,
            build_root: build_root.to_path_buf(),
            docker_socket: docker_socket.to_path_buf(),
        })
    }

    /// Executes the direct bounded build and verifies its OCI-only result.
    ///
    /// This method exclusively creates the build root and the accepted empty
    /// context, writes the independent Dockerfile and generated policy outside
    /// that context, and removes the exact owned root before returning.
    ///
    /// # Errors
    ///
    /// Fails closed before execution on missing capabilities, then on timeout,
    /// command failure, output overflow, layer overflow, or digest mismatch.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn execute<F>(
        &self,
        store: &ImageStore,
        bind_retained_parent: &mut F,
    ) -> Result<VerifiedOciImage, AcquisitionError>
    where
        F: FnMut(&str, &str, File, Instant) -> Result<(), AcquisitionError>,
    {
        let deadline = Instant::now() + self.definition.time_limit;
        let mut owns_build_root = false;
        let result = (|| {
            create_private_dir(&self.build_root)?;
            owns_build_root = true;
            let context_root = self.build_root.join("context");
            create_private_dir(&context_root)?;
            if fs::read_dir(&context_root)?.next().transpose()?.is_some() {
                return Err(AcquisitionError::InvalidBuildDefinition);
            }
            ensure_before(deadline)?;
            BuildCapabilities::probe(&self.docker_socket, &self.build_root, deadline)?;
            let args = self.prepare_build_args(
                store,
                IMAGE_ARCHIVE_MAX_BYTES,
                deadline,
                bind_retained_parent,
            )?;
            ensure_before(deadline)?;
            write_private_file(
                &self.build_root.join("Dockerfile"),
                self.definition.dockerfile.as_bytes(),
            )?;
            write_private_file(
                &self.build_root.join("policy.rego"),
                self.policy_contents.as_bytes(),
            )?;
            ensure_before(deadline)?;
            let mut child = Command::new(&self.program)
                .args(&args)
                .envs(self.env.iter().cloned())
                .env_remove("BUILDX_BUILDER")
                .current_dir(&self.build_root)
                .stdin(Stdio::null())
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit())
                .spawn()
                .map_err(|_| AcquisitionError::Backend)?;
            if !wait_for_child(&mut child, deadline)? {
                return Err(AcquisitionError::Backend);
            }
            ensure_before(deadline)?;
            verify_oci_result(
                &self.build_root.join("result.oci.tar"),
                &self.build_root.join("metadata.json"),
                self.definition.output_limit_bytes,
                self.definition.layer_limit,
                deadline,
            )
        })();
        if owns_build_root {
            match fs::remove_dir_all(&self.build_root) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(_) => return Err(AcquisitionError::Io),
            }
        }
        result
    }

    /// Executes and atomically admits one verified attempt image into the store.
    ///
    /// # Errors
    ///
    /// Returns a build or store-verification failure without changing epoch health.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn execute_and_admit<F>(
        &self,
        store: &ImageStore,
        acquired_at: u64,
        mut bind_retained_parent: F,
    ) -> Result<String, AcquisitionError>
    where
        F: FnMut(&str, &str, File, Instant) -> Result<(), AcquisitionError>,
    {
        let result = self.execute(store, &mut bind_retained_parent)?;
        store
            .admit_oci_file(
                &result.digest,
                result.archive,
                StoreLineage::Build(self.lineage()),
                acquired_at,
            )
            .map_err(|_| AcquisitionError::InvalidOciResult)?;
        Ok(result.digest)
    }

    /// Returns the direct Docker executable.
    pub fn program(&self) -> &Path {
        &self.program
    }

    /// Returns the exact private-socket environment.
    pub fn env(&self) -> &[(String, String)] {
        &self.env
    }

    /// Returns the fixed Buildx argument vector.
    pub fn args(&self) -> &[String] {
        &self.args
    }

    /// Prepares exact private aliases for retained parent images.
    fn prepare_build_args<F>(
        &self,
        store: &ImageStore,
        retained_parent_limit: u64,
        deadline: Instant,
        bind_retained_parent: &mut F,
    ) -> Result<Vec<String>, AcquisitionError>
    where
        F: FnMut(&str, &str, File, Instant) -> Result<(), AcquisitionError>,
    {
        if retained_parent_limit > IMAGE_ARCHIVE_MAX_BYTES {
            return Err(AcquisitionError::InvalidBuildDefinition);
        }
        let mut retained_archives = BTreeMap::<String, Option<File>>::new();
        let mut retained_archive_bytes = 0_u64;
        for reference in &self.from_references {
            if retained_archives.contains_key(&reference.digest) {
                continue;
            }
            ensure_before(deadline)?;
            match store.read_verified_before(&reference.digest, deadline) {
                Ok(archive) => {
                    retained_archive_bytes = retained_archive_bytes
                        .checked_add(archive.metadata()?.len())
                        .filter(|total| *total <= retained_parent_limit)
                        .ok_or(AcquisitionError::InvalidOciResult)?;
                    retained_archives.insert(reference.digest.clone(), Some(archive));
                }
                Err(StoreError::Missing) => {
                    retained_archives.insert(reference.digest.clone(), None);
                }
                Err(_) => return Err(AcquisitionError::InvalidOciResult),
            }
        }

        let mut retained = BTreeMap::<String, Option<String>>::new();
        let mut projected_bytes = 0_u64;
        for (digest, archive) in retained_archives {
            ensure_before(deadline)?;
            match archive {
                Some(mut archive) => {
                    ensure_before(deadline)?;
                    let parents_root = self.build_root.join("parents");
                    if !parents_root.exists() {
                        create_private_dir(&parents_root)?;
                    }
                    let archive_path =
                        parents_root.join(format!("{}.oci.tar", digest_hex(&digest)?));
                    let normalized = create_naming_neutral_oci_archive(
                        &mut archive,
                        &digest,
                        &archive_path,
                        &mut projected_bytes,
                        retained_parent_limit,
                        deadline,
                    )?;
                    let alias = retained_parent_alias(&digest)?;
                    bind_retained_parent(&digest, &alias, normalized, deadline)?;
                    retained.insert(digest, Some(alias));
                }
                None => {
                    retained.insert(digest, None);
                }
            }
        }

        let context = self
            .args
            .last()
            .cloned()
            .ok_or(AcquisitionError::InvalidBuildDefinition)?;
        let mut args = self.args[..self.args.len() - 1].to_vec();
        for reference in &self.from_references {
            if let Some(alias) = retained
                .get(&reference.digest)
                .ok_or(AcquisitionError::InvalidOciResult)?
            {
                args.push("--build-context".into());
                args.push(format!("{}=docker-image://{}", reference.authored, alias));
            }
        }
        args.push(context);
        Ok(args)
    }

    /// Returns the generated strict deny-by-default Rego policy.
    pub fn policy_contents(&self) -> &str {
        &self.policy_contents
    }

    /// Returns the exact union of declared registries and build-only grants.
    pub fn allowed_egress(&self) -> &BTreeSet<String> {
        &self.allowed_egress
    }

    /// Returns no runtime sandbox egress because build authority is not projected.
    pub fn sandbox_egress_projection(&self) -> BTreeSet<String> {
        BTreeSet::new()
    }

    /// Returns deterministic build-definition lineage.
    pub fn lineage(&self) -> String {
        self.definition.lineage()
    }

    /// Returns whether the direct plan uses a shell.
    pub fn uses_shell(&self) -> bool {
        false
    }

    /// Returns whether the plan requests the host network namespace.
    pub fn uses_host_network(&self) -> bool {
        false
    }

    /// Returns whether the plan requests a host mount.
    pub fn uses_host_mount(&self) -> bool {
        false
    }

    /// Returns whether the plan loads, tags, pushes, or publishes its result.
    pub fn publishes(&self) -> bool {
        false
    }
}

/// Verified OCI-only build output retained outside runtime state.
#[derive(Debug)]
pub struct VerifiedOciImage {
    /// Exact OCI manifest digest reported and re-verified from the archive.
    pub digest: String,
    /// Rewound verified archive descriptor retained across build-root cleanup.
    pub archive: File,
    /// Verified archive byte size.
    pub size: u64,
    /// Verified manifest layer count.
    pub layers: u32,
}

/// Validates the immutable bounded build definition.
#[allow(clippy::needless_as_bytes)]
fn validate_build_definition(
    definition: &BuildDefinition,
    declared_registries: &BTreeSet<String>,
) -> Result<(), AcquisitionError> {
    if definition.context_ref != EMPTY_BUILD_CONTEXT_REF
        || definition.context_digest != EMPTY_BUILD_CONTEXT_DIGEST
        || definition.dockerfile.is_empty()
        || definition.dockerfile.as_bytes().len() > DOCKERFILE_INPUT_MAX_BYTES
        || definition.dockerfile.contains('\0')
        || definition.time_limit.is_zero()
        || definition.time_limit > BUILD_MAX_TIME
        || definition.output_limit_bytes == 0
        || definition.output_limit_bytes > BUILD_MAX_OUTPUT_BYTES
        || definition.layer_limit == 0
        || definition.layer_limit > BUILD_MAX_LAYERS
        || definition.egress_grants.is_empty()
        || declared_registries.is_empty()
        || declared_registries
            .iter()
            .any(|host| !matches!(host.as_str(), "docker.io" | "ghcr.io"))
    {
        return Err(AcquisitionError::InvalidBuildDefinition);
    }
    let dockerfile_lower = definition.dockerfile.to_ascii_lowercase();
    // The private resolver namespace is never authored Dockerfile content, including comments.
    if dockerfile_lower.contains(RETAINED_PARENT_ALIAS_REPOSITORY) {
        return Err(AcquisitionError::InvalidBuildDefinition);
    }
    for forbidden in [
        "--mount=type=bind",
        "--network=host",
        "--mount=type=secret",
        "--mount=type=ssh",
    ] {
        if dockerfile_lower.contains(forbidden) {
            return Err(AcquisitionError::InvalidBuildDefinition);
        }
    }
    for line in definition.dockerfile.lines() {
        let line = line.trim();
        let lower = line.to_ascii_lowercase();
        if (lower.starts_with("add ") || lower.starts_with("copy --from="))
            && (lower.contains("http://") || lower.contains("https://") || lower.contains("git://"))
        {
            return Err(AcquisitionError::InvalidBuildDefinition);
        }
    }
    for (key, value) in &definition.arguments {
        if !valid_argument_name(key)
            || value.contains(['\0', '\r', '\n'])
            || secret_bearing_name(key)
        {
            return Err(AcquisitionError::InvalidBuildDefinition);
        }
    }
    for grant in &definition.egress_grants {
        validate_egress_grant(grant)?;
    }
    Ok(())
}

/// Renders the closed strict Buildx policy from already validated values.
fn render_policy(
    registries: &BTreeSet<String>,
    grants: &BTreeSet<String>,
    image_refs: &BTreeSet<String>,
    retained_parent_aliases: &BTreeMap<String, String>,
) -> String {
    let mut lines = vec![
        "package docker".to_string(),
        String::new(),
        "default allow := false".into(),
        "default deny_msg := []".into(),
        "default caps := {}".into(),
        String::new(),
        "caps := {\"exec.proxy\": true} if input.env.capsRequest".into(),
        "allow if input.env.capsRequest".into(),
        "allow if input.local".into(),
    ];
    for host in grants.iter().filter(|grant| !grant.starts_with("https://")) {
        let authority = if host.contains(':') {
            host.clone()
        } else {
            format!("{host}:443")
        };
        lines.extend([
            String::new(),
            "allow if {".into(),
            "\tinput.http.schema == \"https\"".into(),
            format!("\tinput.http.host == \"{authority}\""),
            "}".into(),
        ]);
    }
    for host in registries {
        lines.extend([
            String::new(),
            "allow if {".into(),
            format!("\tinput.image.host == \"{host}:443\""),
            "}".into(),
        ]);
    }
    for url in grants.iter().filter(|grant| grant.starts_with("https://")) {
        let endpoint = url
            .strip_prefix("https://")
            .expect("validated HTTPS endpoint");
        let (authority, path) = endpoint
            .split_once('/')
            .expect("validated complete HTTPS endpoint");
        let policy_url = if authority.contains(':') {
            url.clone()
        } else {
            format!("https://{authority}:443/{path}")
        };
        lines.extend([
            String::new(),
            "allow if {".into(),
            format!("\tinput.http.url == \"{policy_url}\""),
            "}".into(),
        ]);
    }
    for reference in image_refs {
        lines.extend([
            String::new(),
            "allow if {".into(),
            format!("\tinput.image.ref == \"{reference}\""),
            "}".into(),
        ]);
    }
    for (alias, digest) in retained_parent_aliases {
        lines.extend([
            String::new(),
            "allow if {".into(),
            format!("\tinput.image.ref == \"{alias}\""),
            format!("\tinput.image.checksum == \"{digest}\""),
            "}".into(),
        ]);
    }
    lines.extend([
        String::new(),
        "deny_msg := [\"source or build egress endpoint is outside the declared ceiling\"] if not allow".into(),
        "decision := {\"allow\": allow, \"deny_msg\": deny_msg, \"caps\": caps}".into(),
        String::new(),
    ]);
    lines.join("\n")
}

/// Returns the deterministic epoch-private resolver alias for one manifest digest.
///
/// # Errors
///
/// Rejects a non-canonical digest before forming a Docker reference.
pub(crate) fn retained_parent_alias(digest: &str) -> Result<String, AcquisitionError> {
    Ok(format!(
        "{RETAINED_PARENT_ALIAS_REPOSITORY}:{}",
        digest_hex(digest)?
    ))
}

/// One exact immutable parent reference, preserving both source spelling and identity.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct ExactFromReference {
    authored: String,
    canonical: String,
    digest: String,
}

/// Extracts exact immutable non-scratch `FROM` references from Dockerfile data.
fn exact_from_references(
    dockerfile: &str,
    declared_registries: &BTreeSet<String>,
) -> Result<BTreeSet<ExactFromReference>, AcquisitionError> {
    let mut references = BTreeSet::new();
    for line in dockerfile.lines() {
        let mut words = line.split_whitespace();
        if !words
            .next()
            .is_some_and(|word| word.eq_ignore_ascii_case("FROM"))
        {
            continue;
        }
        let reference = words
            .find(|word| !word.starts_with("--"))
            .ok_or(AcquisitionError::InvalidBuildDefinition)?;
        if reference.eq_ignore_ascii_case("scratch") {
            continue;
        }
        let parsed =
            Reference::try_from(reference).map_err(|_| AcquisitionError::InvalidBuildDefinition)?;
        let digest = parsed
            .digest()
            .ok_or(AcquisitionError::InvalidBuildDefinition)?;
        validate_digest(digest)?;
        if reference.contains(['\r', '\n', '"']) || !declared_registries.contains(parsed.registry())
        {
            return Err(AcquisitionError::InvalidBuildDefinition);
        }
        references.insert(ExactFromReference {
            authored: reference.to_string(),
            canonical: parsed.whole(),
            digest: digest.to_string(),
        });
    }
    Ok(references)
}

/// Validates an exact hostname or complete HTTPS endpoint grant.
fn validate_egress_grant(value: &str) -> Result<(), AcquisitionError> {
    if value.is_empty()
        || value.contains(['*', '"', '\'', '\\', '\r', '\n', '\0'])
        || value.starts_with('.')
    {
        return Err(AcquisitionError::InvalidBuildDefinition);
    }
    if let Some(endpoint) = value.strip_prefix("https://") {
        let (authority, path) = endpoint
            .split_once('/')
            .ok_or(AcquisitionError::InvalidBuildDefinition)?;
        let host = authority
            .split_once(':')
            .map_or(authority, |(host, _)| host);
        if !valid_hostname(host) || path.is_empty() || path.contains('*') {
            return Err(AcquisitionError::InvalidBuildDefinition);
        }
        if let Some((_, port)) = authority.split_once(':') {
            let port = port
                .parse::<u16>()
                .map_err(|_| AcquisitionError::InvalidBuildDefinition)?;
            if port == 0 {
                return Err(AcquisitionError::InvalidBuildDefinition);
            }
        }
        return Ok(());
    }
    let (host, port) = value
        .split_once(':')
        .map_or((value, None), |(host, port)| (host, Some(port)));
    if value.contains("://")
        || value.contains('/')
        || !valid_hostname(host)
        || port.is_some_and(|port| port.parse::<u16>().ok().is_none_or(|port| port == 0))
    {
        return Err(AcquisitionError::InvalidBuildDefinition);
    }
    Ok(())
}

/// Returns whether a hostname is exact ASCII DNS syntax without suffix shorthand.
fn valid_hostname(value: &str) -> bool {
    value.len() <= 253
        && value.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
}

/// Returns whether a build argument name has closed environment-key syntax.
fn valid_argument_name(value: &str) -> bool {
    let mut bytes = value.bytes();
    bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_uppercase() || byte == b'_')
        && bytes.all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

/// Rejects build argument names likely to carry credentials.
fn secret_bearing_name(value: &str) -> bool {
    [
        "TOKEN",
        "SECRET",
        "PASSWORD",
        "PASSWD",
        "CREDENTIAL",
        "PRIVATE_KEY",
        "API_KEY",
    ]
    .iter()
    .any(|marker| value.contains(marker))
}

/// Adds a length-delimited field to deterministic lineage hashing.
fn hash_field(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value);
}

/// Validates a canonical lowercase SHA-256 digest.
fn validate_digest(value: &str) -> Result<(), AcquisitionError> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err(AcquisitionError::InvalidBuildDefinition);
    };
    if hex.len() == 64
        && hex
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        Ok(())
    } else {
        Err(AcquisitionError::InvalidBuildDefinition)
    }
}

/// Validates one absolute, traversal-free owner path.
fn validate_owned_path(path: &Path) -> Result<(), AcquisitionError> {
    if path.is_absolute()
        && path.components().all(|component| {
            matches!(
                component,
                Component::RootDir | Component::Normal(_) | Component::Prefix(_)
            )
        })
    {
        Ok(())
    } else {
        Err(AcquisitionError::InvalidBuildDefinition)
    }
}

/// Parses the first numeric semantic version from command output.
fn first_semver(value: &str) -> Option<String> {
    value.split_whitespace().find_map(|word| {
        let candidate = word
            .trim_matches(|character: char| !character.is_ascii_alphanumeric() && character != '.');
        let candidate = candidate.strip_prefix('v').unwrap_or(candidate);
        parse_version(candidate).map(|version| format!("{}.{}.{}", version.0, version.1, version.2))
    })
}

/// Returns whether a semantic version meets a minimum tuple.
fn version_at_least(value: &str, minimum: (u64, u64, u64)) -> bool {
    parse_version(value).is_some_and(|version| version >= minimum)
}

/// Parses the numeric major, minor, and patch prefix.
fn parse_version(value: &str) -> Option<(u64, u64, u64)> {
    let value = value.trim().trim_start_matches('v');
    let mut parts = value.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts
        .next()?
        .split(|character: char| !character.is_ascii_digit())
        .next()?
        .parse()
        .ok()?;
    Some((major, minor, patch))
}

/// Creates a private build directory.
fn create_private_dir(path: &Path) -> Result<(), AcquisitionError> {
    validate_owned_path(path)?;
    let parent = path
        .parent()
        .filter(|parent| *parent != path)
        .ok_or(AcquisitionError::InvalidBuildDefinition)?;
    if parent.exists() {
        let metadata = fs::symlink_metadata(parent)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(AcquisitionError::InvalidBuildDefinition);
        }
    } else {
        DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(parent)?;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
    }
    DirBuilder::new().mode(0o700).create(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

/// Writes one private generated build input without following an existing path.
fn write_private_file(path: &Path, contents: &[u8]) -> Result<(), AcquisitionError> {
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(contents)?;
    file.sync_all()?;
    Ok(())
}

/// Runs one fixed Docker capability command inside the whole-build deadline.
fn bounded_command_output(
    command: &mut Command,
    output_path: &Path,
    deadline: Instant,
) -> Result<String, AcquisitionError> {
    ensure_before(deadline).map_err(|_| AcquisitionError::UnsupportedBuildCapability)?;
    let output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(output_path)?;
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::from(output))
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| AcquisitionError::UnsupportedBuildCapability)?;
    if !wait_for_child(&mut child, deadline)
        .map_err(|_| AcquisitionError::UnsupportedBuildCapability)?
    {
        return Err(AcquisitionError::UnsupportedBuildCapability);
    }
    ensure_before(deadline).map_err(|_| AcquisitionError::UnsupportedBuildCapability)?;
    let output = read_bounded_regular_utf8(output_path, OCI_DOCUMENT_MAX_BYTES)
        .map_err(|_| AcquisitionError::UnsupportedBuildCapability)?;
    ensure_before(deadline).map_err(|_| AcquisitionError::UnsupportedBuildCapability)?;
    Ok(output)
}

/// Returns the positive duration remaining in one whole-build deadline.
fn remaining_before(deadline: Instant) -> Result<Duration, AcquisitionError> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or(AcquisitionError::Backend)
}

/// Fails when local preparation consumed the complete build deadline.
fn ensure_before(deadline: Instant) -> Result<(), AcquisitionError> {
    remaining_before(deadline).map(|_| ())
}

/// Read-and-seek view that checks one absolute deadline around every bounded operation.
struct DeadlineReader<'a, R> {
    inner: &'a mut R,
    deadline: Instant,
}

impl<'a, R> DeadlineReader<'a, R> {
    fn new(inner: &'a mut R, deadline: Instant) -> Self {
        Self { inner, deadline }
    }

    fn check(&self) -> io::Result<()> {
        if Instant::now() < self.deadline {
            Ok(())
        } else {
            Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "archive operation exceeded its deadline",
            ))
        }
    }
}

impl<R: Read> Read for DeadlineReader<'_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.check()?;
        let bounded = buffer.len().min(ARCHIVE_CHUNK_BYTES);
        let read = self.inner.read(&mut buffer[..bounded])?;
        self.check()?;
        Ok(read)
    }
}

impl<R: Seek> Seek for DeadlineReader<'_, R> {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        self.check()?;
        let offset = self.inner.seek(position)?;
        self.check()?;
        Ok(offset)
    }
}

/// Waits for one direct child until the absolute build deadline.
fn wait_for_child(child: &mut Child, deadline: Instant) -> Result<bool, AcquisitionError> {
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status.success()),
            Ok(None) => thread::sleep(
                deadline
                    .saturating_duration_since(Instant::now())
                    .min(Duration::from_millis(50)),
            ),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AcquisitionError::Backend);
            }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    Err(AcquisitionError::Backend)
}

/// Verifies one OCI archive, its metadata digest, size, and layer bound.
fn verify_oci_result(
    archive_path: &Path,
    metadata_path: &Path,
    output_limit: u64,
    layer_limit: u32,
    deadline: Instant,
) -> Result<VerifiedOciImage, AcquisitionError> {
    ensure_before(deadline)?;
    let size = fs::metadata(archive_path)?.len();
    if size == 0 || size > output_limit || size > BUILD_MAX_OUTPUT_BYTES {
        return Err(AcquisitionError::InvalidOciResult);
    }
    let metadata =
        read_bounded_regular_utf8_before(metadata_path, OCI_DOCUMENT_MAX_BYTES, deadline)?;
    let metadata_digest = json_string(&metadata, "containerimage.digest")
        .ok_or(AcquisitionError::InvalidOciResult)?;
    validate_digest(&metadata_digest).map_err(|_| AcquisitionError::InvalidOciResult)?;
    let mut archive = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(archive_path)?;
    if !archive.metadata()?.is_file() {
        return Err(AcquisitionError::InvalidOciResult);
    }
    let verified = verify_oci_archive_before(&mut archive, Some(&metadata_digest), deadline)?;
    let digest = verified.digest;
    if digest != metadata_digest {
        return Err(AcquisitionError::InvalidOciResult);
    }
    let layers = verified.layers;
    if layers > layer_limit {
        return Err(AcquisitionError::InvalidOciResult);
    }
    ensure_before(deadline)?;
    Ok(VerifiedOciImage {
        digest,
        archive,
        size,
        layers,
    })
}

/// Returns the verified top-level OCI manifest digest from an archive.
///
/// # Errors
///
/// Rejects malformed archives, missing index/blob members, and blob mismatch.
pub(crate) fn verify_oci_archive<R: Read + Seek>(
    archive: &mut R,
    expected_digest: Option<&str>,
) -> Result<VerifiedArchive, AcquisitionError> {
    let archive_size = archive.seek(SeekFrom::End(0))?;
    if archive_size == 0 || archive_size > IMAGE_ARCHIVE_MAX_BYTES {
        return Err(AcquisitionError::InvalidOciResult);
    }
    let layout_bytes = read_bounded_tar_member(archive, "oci-layout", OCI_DOCUMENT_MAX_BYTES)?
        .ok_or(AcquisitionError::InvalidOciResult)?;
    let layout: serde_json::Value =
        serde_json::from_slice(&layout_bytes).map_err(|_| AcquisitionError::InvalidOciResult)?;
    let layout = layout
        .as_object()
        .ok_or(AcquisitionError::InvalidOciResult)?;
    if layout.len() != 1
        || layout
            .get("imageLayoutVersion")
            .and_then(serde_json::Value::as_str)
            != Some("1.0.0")
    {
        return Err(AcquisitionError::InvalidOciResult);
    }
    let index_bytes = read_bounded_tar_member(archive, "index.json", OCI_DOCUMENT_MAX_BYTES)?
        .ok_or(AcquisitionError::InvalidOciResult)?;
    let index: serde_json::Value =
        serde_json::from_slice(&index_bytes).map_err(|_| AcquisitionError::InvalidOciResult)?;
    let index = index
        .as_object()
        .ok_or(AcquisitionError::InvalidOciResult)?;
    if index
        .keys()
        .any(|key| !matches!(key.as_str(), "schemaVersion" | "mediaType" | "manifests"))
        || index
            .get("schemaVersion")
            .and_then(serde_json::Value::as_u64)
            != Some(2)
        || index.get("mediaType").is_some_and(|media_type| {
            media_type.as_str() != Some("application/vnd.oci.image.index.v1+json")
        })
    {
        return Err(AcquisitionError::InvalidOciResult);
    }
    let manifests = index
        .get("manifests")
        .and_then(serde_json::Value::as_array)
        .ok_or(AcquisitionError::InvalidOciResult)?;
    let [descriptor] = manifests.as_slice() else {
        return Err(AcquisitionError::InvalidOciResult);
    };
    let descriptor = descriptor
        .as_object()
        .ok_or(AcquisitionError::InvalidOciResult)?;
    if descriptor.keys().any(|key| {
        !matches!(
            key.as_str(),
            "mediaType" | "digest" | "size" | "annotations" | "platform"
        )
    }) {
        return Err(AcquisitionError::InvalidOciResult);
    }
    let media_type = descriptor
        .get("mediaType")
        .and_then(serde_json::Value::as_str)
        .ok_or(AcquisitionError::InvalidOciResult)?;
    let digest = descriptor
        .get("digest")
        .and_then(serde_json::Value::as_str)
        .ok_or(AcquisitionError::InvalidOciResult)?
        .to_string();
    let declared_size = descriptor
        .get("size")
        .and_then(serde_json::Value::as_u64)
        .ok_or(AcquisitionError::InvalidOciResult)?;
    if !matches!(media_type, OCI_IMAGE_MEDIA_TYPE | IMAGE_MANIFEST_MEDIA_TYPE) {
        return Err(AcquisitionError::InvalidOciResult);
    }
    if let Some(annotations) = descriptor.get("annotations") {
        let annotations = annotations
            .as_object()
            .ok_or(AcquisitionError::InvalidOciResult)?;
        if annotations
            .iter()
            .any(|(key, value)| key.is_empty() || !value.is_string())
        {
            return Err(AcquisitionError::InvalidOciResult);
        }
    }
    if let Some(platform) = descriptor.get("platform") {
        let platform = platform
            .as_object()
            .ok_or(AcquisitionError::InvalidOciResult)?;
        if platform.keys().any(|key| {
            !matches!(
                key.as_str(),
                "architecture" | "os" | "os.version" | "os.features" | "variant"
            )
        }) || platform
            .get("architecture")
            .and_then(serde_json::Value::as_str)
            .is_none_or(|value| value.is_empty())
            || platform
                .get("os")
                .and_then(serde_json::Value::as_str)
                .is_none_or(|value| value.is_empty())
            || platform
                .get("os.version")
                .is_some_and(|value| value.as_str().is_none_or(|value| value.is_empty()))
            || platform
                .get("variant")
                .is_some_and(|value| value.as_str().is_none_or(|value| value.is_empty()))
            || platform.get("os.features").is_some_and(|value| {
                !value.as_array().is_some_and(|features| {
                    features
                        .iter()
                        .all(|feature| feature.as_str().is_some_and(|feature| !feature.is_empty()))
                })
            })
        {
            return Err(AcquisitionError::InvalidOciResult);
        }
    }
    validate_digest(&digest).map_err(|_| AcquisitionError::InvalidOciResult)?;
    if expected_digest.is_some_and(|expected| expected != digest) {
        return Err(AcquisitionError::DigestMismatch);
    }
    let manifest_name = format!("blobs/sha256/{}", digest_hex(&digest)?);
    let manifest_bytes = read_bounded_tar_member(archive, &manifest_name, OCI_DOCUMENT_MAX_BYTES)?
        .ok_or(AcquisitionError::InvalidOciResult)?;
    if format!("sha256:{:x}", Sha256::digest(&manifest_bytes)) != digest {
        return Err(AcquisitionError::InvalidOciResult);
    }
    let manifest = parse_image_manifest(&manifest_bytes)?;
    if manifest_bytes.len() as u64 != declared_size
        || manifest.media_type.as_deref() != Some(media_type)
    {
        return Err(AcquisitionError::InvalidOciResult);
    }
    let descriptors = validated_descriptor_sizes(&manifest, manifest_bytes.len() as u64)?;
    verify_descriptor_members(archive, &manifest.config.digest, &descriptors)?;
    let mut members = BTreeMap::from([(
        manifest_name,
        VerifiedArchiveMember::from_bytes(&manifest_bytes),
    )]);
    for (descriptor_digest, size) in descriptors {
        let name = format!("blobs/sha256/{}", digest_hex(&descriptor_digest)?);
        if members
            .insert(
                name,
                VerifiedArchiveMember {
                    size,
                    sha256: descriptor_digest,
                },
            )
            .is_some()
        {
            return Err(AcquisitionError::InvalidOciResult);
        }
    }
    archive.seek(SeekFrom::Start(0))?;
    Ok(VerifiedArchive {
        digest,
        layers: manifest.layers.len() as u32,
        manifest_media_type: media_type.to_string(),
        config_digest: manifest.config.digest,
        members,
    })
}

/// Verifies one OCI archive while enforcing an absolute caller deadline.
pub(crate) fn verify_oci_archive_before<R: Read + Seek>(
    archive: &mut R,
    expected_digest: Option<&str>,
    deadline: Instant,
) -> Result<VerifiedArchive, AcquisitionError> {
    let mut bounded = DeadlineReader::new(archive, deadline);
    verify_oci_archive(&mut bounded, expected_digest)
}

/// Rejects archive-carried names that could mutate the retained-parent alias namespace.
///
/// # Errors
///
/// Rejects malformed or ambiguous naming metadata and any normalized name in the
/// fixed private retained-parent repository. The reader is rewound on success.
pub(crate) fn verify_raw_import_names<R: Read + Seek>(
    archive: &mut R,
) -> Result<(), AcquisitionError> {
    let index_bytes = read_bounded_tar_member(archive, "index.json", OCI_DOCUMENT_MAX_BYTES)?
        .ok_or(AcquisitionError::InvalidOciResult)?;
    let index: serde_json::Value =
        serde_json::from_slice(&index_bytes).map_err(|_| AcquisitionError::InvalidOciResult)?;
    let manifests = index
        .as_object()
        .and_then(|index| index.get("manifests"))
        .and_then(serde_json::Value::as_array)
        .ok_or(AcquisitionError::InvalidOciResult)?;
    let [descriptor] = manifests.as_slice() else {
        return Err(AcquisitionError::InvalidOciResult);
    };
    if let Some(annotations) = descriptor
        .as_object()
        .ok_or(AcquisitionError::InvalidOciResult)?
        .get("annotations")
    {
        let annotations = annotations
            .as_object()
            .ok_or(AcquisitionError::InvalidOciResult)?;
        for key in [
            "io.containerd.image.name",
            "org.opencontainers.image.ref.name",
        ] {
            if let Some(value) = annotations.get(key) {
                let value = value.as_str().ok_or(AcquisitionError::InvalidOciResult)?;
                if image_name_uses_reserved_alias(value)? {
                    return Err(AcquisitionError::InvalidOciResult);
                }
            }
        }
    }

    if let Some(compatibility_bytes) =
        read_bounded_tar_member(archive, "manifest.json", OCI_DOCUMENT_MAX_BYTES)?
    {
        let compatibility: serde_json::Value = serde_json::from_slice(&compatibility_bytes)
            .map_err(|_| AcquisitionError::InvalidOciResult)?;
        let entries = compatibility
            .as_array()
            .ok_or(AcquisitionError::InvalidOciResult)?;
        let [entry] = entries.as_slice() else {
            return Err(AcquisitionError::InvalidOciResult);
        };
        let entry = entry
            .as_object()
            .ok_or(AcquisitionError::InvalidOciResult)?;
        if let Some(repo_tags) = entry.get("RepoTags")
            && !repo_tags.is_null()
        {
            let repo_tags = repo_tags
                .as_array()
                .ok_or(AcquisitionError::InvalidOciResult)?;
            for repo_tag in repo_tags {
                let repo_tag = repo_tag
                    .as_str()
                    .ok_or(AcquisitionError::InvalidOciResult)?;
                if image_name_uses_reserved_alias(repo_tag)? {
                    return Err(AcquisitionError::InvalidOciResult);
                }
            }
        }
    }
    archive.seek(SeekFrom::Start(0))?;
    Ok(())
}

/// Verifies raw import names while enforcing an absolute caller deadline.
pub(crate) fn verify_raw_import_names_before<R: Read + Seek>(
    archive: &mut R,
    deadline: Instant,
) -> Result<(), AcquisitionError> {
    let mut bounded = DeadlineReader::new(archive, deadline);
    verify_raw_import_names(&mut bounded)
}

/// Normalizes one Docker image name before comparing the reserved repository.
fn image_name_uses_reserved_alias(value: &str) -> Result<bool, AcquisitionError> {
    if value.is_empty() || value.contains(['\r', '\n', '\0']) {
        return Err(AcquisitionError::InvalidOciResult);
    }
    let reference = Reference::try_from(value).map_err(|_| AcquisitionError::InvalidOciResult)?;
    Ok(reference.registry().eq_ignore_ascii_case("openkit.invalid")
        && reference.repository() == "retained-parent")
}

/// Bounded verification result needed by store and build admission.
pub(crate) struct VerifiedArchive {
    digest: String,
    layers: u32,
    manifest_media_type: String,
    config_digest: String,
    members: BTreeMap<String, VerifiedArchiveMember>,
}

/// Exact member identity for one verified OCI image graph projection.
#[derive(Debug, Clone, PartialEq, Eq)]
struct VerifiedArchiveMember {
    size: u64,
    sha256: String,
}

impl VerifiedArchiveMember {
    /// Captures the exact hash and bounded size of one verified metadata member.
    fn from_bytes(contents: &[u8]) -> Self {
        Self {
            size: contents.len() as u64,
            sha256: format!("sha256:{:x}", Sha256::digest(contents)),
        }
    }
}

/// Creates one naming-neutral retained-parent archive under the owned build root.
fn create_naming_neutral_oci_archive<R: Read + Seek>(
    archive: &mut R,
    expected_digest: &str,
    output_path: &Path,
    projected_bytes: &mut u64,
    aggregate_limit: u64,
    deadline: Instant,
) -> Result<File, AcquisitionError> {
    if aggregate_limit > IMAGE_ARCHIVE_MAX_BYTES {
        return Err(AcquisitionError::InvalidBuildDefinition);
    }
    let verified = verify_oci_archive_before(archive, Some(expected_digest), deadline)?;
    ensure_before(deadline)?;
    let mut output = OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(output_path)?;
    let layout_bytes = b"{\"imageLayoutVersion\":\"1.0.0\"}\n";
    let manifest = verified
        .members
        .get(&format!("blobs/sha256/{}", digest_hex(&verified.digest)?))
        .ok_or(AcquisitionError::InvalidOciResult)?;
    let index = format!(
        "{{\"schemaVersion\":2,\"manifests\":[{{\"mediaType\":{},\"digest\":{},\"size\":{}}}]}}\n",
        serde_json::to_string(&verified.manifest_media_type)
            .map_err(|_| AcquisitionError::InvalidOciResult)?,
        serde_json::to_string(&verified.digest).map_err(|_| AcquisitionError::InvalidOciResult)?,
        manifest.size,
    );
    append_projected_tar_bytes(
        &mut output,
        "oci-layout",
        layout_bytes,
        projected_bytes,
        aggregate_limit,
        deadline,
    )?;
    append_projected_tar_bytes(
        &mut output,
        "index.json",
        index.as_bytes(),
        projected_bytes,
        aggregate_limit,
        deadline,
    )?;

    let mut remaining = verified.members.keys().cloned().collect::<BTreeSet<_>>();
    let mut layout_seen = false;
    let mut index_seen = false;
    let mut blobs_directory_seen = false;
    let mut sha256_directory_seen = false;
    let mut compatibility_manifest_seen = false;
    let mut bounded_archive = DeadlineReader::new(archive, deadline);
    bounded_archive.seek(SeekFrom::Start(0))?;
    while let Some(header) = next_tar_header(&mut bounded_archive)? {
        if let Some(expected) = verified.members.get(&header.name) {
            if !remaining.remove(&header.name) || !header.regular || header.size != expected.size {
                return Err(AcquisitionError::InvalidOciResult);
            }
            append_projected_tar_header(
                &mut output,
                &header.name,
                header.size,
                projected_bytes,
                aggregate_limit,
                deadline,
            )?;
            let mut hasher = Sha256::new();
            read_member_stream(&mut bounded_archive, header.size, |chunk| {
                hasher.update(chunk);
                write_projected_bytes(
                    &mut output,
                    chunk,
                    projected_bytes,
                    aggregate_limit,
                    deadline,
                )
            })?;
            if format!("sha256:{:x}", hasher.finalize()) != expected.sha256 {
                return Err(AcquisitionError::InvalidOciResult);
            }
            append_projected_tar_padding(
                &mut output,
                header.size,
                projected_bytes,
                aggregate_limit,
                deadline,
            )?;
        } else {
            match header.name.as_str() {
                "oci-layout" => {
                    if layout_seen || !header.regular || header.size > OCI_DOCUMENT_MAX_BYTES as u64
                    {
                        return Err(AcquisitionError::InvalidOciResult);
                    }
                    layout_seen = true;
                }
                "index.json" => {
                    if index_seen || !header.regular || header.size > OCI_DOCUMENT_MAX_BYTES as u64
                    {
                        return Err(AcquisitionError::InvalidOciResult);
                    }
                    index_seen = true;
                }
                "blobs" | "blobs/" => {
                    if blobs_directory_seen || header.regular || header.size != 0 {
                        return Err(AcquisitionError::InvalidOciResult);
                    }
                    blobs_directory_seen = true;
                }
                "blobs/sha256" | "blobs/sha256/" => {
                    if sha256_directory_seen || header.regular || header.size != 0 {
                        return Err(AcquisitionError::InvalidOciResult);
                    }
                    sha256_directory_seen = true;
                }
                "manifest.json" => {
                    if compatibility_manifest_seen
                        || !header.regular
                        || header.size > OCI_DOCUMENT_MAX_BYTES as u64
                    {
                        return Err(AcquisitionError::InvalidOciResult);
                    }
                    compatibility_manifest_seen = true;
                }
                _ => return Err(AcquisitionError::InvalidOciResult),
            }
            read_member_stream(&mut bounded_archive, header.size, |_| Ok(()))?;
        }
        seek_tar_padding(&mut bounded_archive, header.size)?;
    }
    if !layout_seen || !index_seen || !remaining.is_empty() {
        return Err(AcquisitionError::InvalidOciResult);
    }
    write_projected_bytes(
        &mut output,
        &[0_u8; 1024],
        projected_bytes,
        aggregate_limit,
        deadline,
    )?;
    output.sync_all()?;
    output.seek(SeekFrom::Start(0))?;
    let normalized = verify_oci_archive_before(&mut output, Some(expected_digest), deadline)?;
    if normalized.manifest_media_type != verified.manifest_media_type
        || normalized.config_digest != verified.config_digest
        || normalized.members != verified.members
        || normalized.layers != verified.layers
    {
        return Err(AcquisitionError::InvalidOciResult);
    }
    verify_raw_import_names_before(&mut output, deadline)?;
    bounded_archive.seek(SeekFrom::Start(0))?;
    output.seek(SeekFrom::Start(0))?;
    Ok(output)
}

/// Appends one bounded generated tar member to the normalized parent archive.
fn append_projected_tar_bytes(
    output: &mut File,
    name: &str,
    contents: &[u8],
    projected_bytes: &mut u64,
    aggregate_limit: u64,
    deadline: Instant,
) -> Result<(), AcquisitionError> {
    append_projected_tar_header(
        output,
        name,
        contents.len() as u64,
        projected_bytes,
        aggregate_limit,
        deadline,
    )?;
    write_projected_bytes(output, contents, projected_bytes, aggregate_limit, deadline)?;
    append_projected_tar_padding(
        output,
        contents.len() as u64,
        projected_bytes,
        aggregate_limit,
        deadline,
    )
}

/// Appends one deterministic regular-file ustar header under the shared bound.
fn append_projected_tar_header(
    output: &mut File,
    name: &str,
    size: u64,
    projected_bytes: &mut u64,
    aggregate_limit: u64,
    deadline: Instant,
) -> Result<(), AcquisitionError> {
    let header = regular_tar_header(name, size)?;
    write_projected_bytes(output, &header, projected_bytes, aggregate_limit, deadline)
}

/// Appends deterministic zero padding for one generated tar member.
fn append_projected_tar_padding(
    output: &mut File,
    size: u64,
    projected_bytes: &mut u64,
    aggregate_limit: u64,
    deadline: Instant,
) -> Result<(), AcquisitionError> {
    let padding = ((512 - size % 512) % 512) as usize;
    write_projected_bytes(
        output,
        &[0_u8; 512][..padding],
        projected_bytes,
        aggregate_limit,
        deadline,
    )
}

/// Writes one archive slice while enforcing aggregate bytes and the whole deadline.
fn write_projected_bytes(
    output: &mut File,
    contents: &[u8],
    projected_bytes: &mut u64,
    aggregate_limit: u64,
    deadline: Instant,
) -> Result<(), AcquisitionError> {
    ensure_before(deadline)?;
    *projected_bytes = projected_bytes
        .checked_add(contents.len() as u64)
        .filter(|total| *total <= aggregate_limit)
        .ok_or(AcquisitionError::InvalidOciResult)?;
    output.write_all(contents)?;
    Ok(())
}

/// Byte-slice adapter retained only for compact test fixtures.
#[cfg(test)]
pub(crate) fn oci_manifest_digest(content: &[u8]) -> Result<String, AcquisitionError> {
    let mut archive = std::io::Cursor::new(content);
    verify_oci_archive(&mut archive, None).map(|verified| verified.digest)
}

/// Verifies all referenced blobs in one streaming archive pass.
fn verify_descriptor_members<R: Read + Seek>(
    archive: &mut R,
    config_digest: &str,
    descriptors: &BTreeMap<String, u64>,
) -> Result<(), AcquisitionError> {
    let mut remaining = descriptors.clone();
    let mut observed = BTreeSet::new();
    archive.seek(SeekFrom::Start(0))?;
    while let Some(header) = next_tar_header(archive)? {
        let wanted_digest = header
            .name
            .strip_prefix("blobs/sha256/")
            .map(|stem| format!("sha256:{stem}"));
        if let Some(digest) = wanted_digest
            .as_ref()
            .filter(|digest| descriptors.contains_key(*digest))
        {
            if !header.regular {
                return Err(AcquisitionError::InvalidOciResult);
            }
            if !observed.insert(digest.clone()) {
                return Err(AcquisitionError::InvalidOciResult);
            }
            let expected_size = *remaining
                .get(digest)
                .ok_or(AcquisitionError::InvalidOciResult)?;
            if header.size != expected_size {
                return Err(AcquisitionError::InvalidOciResult);
            }
            let capture_config = digest == config_digest;
            if capture_config && header.size > OCI_DOCUMENT_MAX_BYTES as u64 {
                return Err(AcquisitionError::InvalidOciResult);
            }
            let mut hasher = Sha256::new();
            let mut captured = if capture_config {
                Vec::with_capacity(header.size as usize)
            } else {
                Vec::new()
            };
            read_member_stream(archive, header.size, |chunk| {
                hasher.update(chunk);
                if capture_config {
                    captured.extend_from_slice(chunk);
                }
                Ok(())
            })?;
            if format!("sha256:{:x}", hasher.finalize()) != *digest {
                return Err(AcquisitionError::InvalidOciResult);
            }
            if capture_config {
                serde_json::from_slice::<serde_json::Value>(&captured)
                    .map_err(|_| AcquisitionError::InvalidOciResult)?;
            }
            remaining.remove(digest);
        } else {
            read_member_stream(archive, header.size, |_| Ok(()))?;
        }
        seek_tar_padding(archive, header.size)?;
    }
    if remaining.is_empty() {
        Ok(())
    } else {
        Err(AcquisitionError::InvalidOciResult)
    }
}

/// Archives one verified minimal layout in the fixed uncompressed OCI tar shape.
fn archive_registry_layout(
    staging_root: &Path,
    manifest_digest: &str,
    descriptor_sizes: &BTreeMap<String, u64>,
) -> Result<File, AcquisitionError> {
    let mut members = vec!["oci-layout".to_string(), "index.json".to_string()];
    members.push(format!("blobs/sha256/{}", digest_hex(manifest_digest)?));
    members.extend(
        descriptor_sizes
            .keys()
            .map(|digest| digest_hex(digest).map(|stem| format!("blobs/sha256/{stem}")))
            .collect::<Result<Vec<_>, _>>()?,
    );
    let archive_path = staging_root.join("result.oci.tar");
    let mut archive = OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&archive_path)?;
    let mut archive_size = 0_u64;
    for member in members {
        append_tar_file(
            &mut archive,
            &staging_root.join(&member),
            &member,
            &mut archive_size,
        )?;
    }
    archive_size = archive_size
        .checked_add(1024)
        .filter(|size| *size <= IMAGE_ARCHIVE_MAX_BYTES)
        .ok_or(AcquisitionError::InvalidOciResult)?;
    archive.write_all(&[0_u8; 1024])?;
    archive.sync_all()?;
    sync_dir(staging_root)?;
    archive.seek(SeekFrom::Start(0))?;
    debug_assert_eq!(archive.metadata()?.len(), archive_size);
    Ok(archive)
}

#[cfg(test)]
fn archived_layout_digest(
    staging_root: &Path,
    manifest_digest: &str,
    descriptor_sizes: &BTreeMap<String, u64>,
) -> Result<String, AcquisitionError> {
    let mut archive = archive_registry_layout(staging_root, manifest_digest, descriptor_sizes)?;
    fs::remove_file(staging_root.join("result.oci.tar"))?;
    verify_oci_archive(&mut archive, None).map(|verified| verified.digest)
}

/// Appends one regular file to a deterministic ustar archive in bounded chunks.
fn append_tar_file(
    archive: &mut File,
    source_path: &Path,
    name: &str,
    archive_size: &mut u64,
) -> Result<(), AcquisitionError> {
    if !name.is_ascii() || name.len() > 100 {
        return Err(AcquisitionError::InvalidOciResult);
    }
    let mut source = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(source_path)?;
    let metadata = source.metadata()?;
    if !metadata.is_file() {
        return Err(AcquisitionError::InvalidOciResult);
    }
    let contents_len = metadata.len();
    let required = 512_u64
        .checked_add(contents_len)
        .and_then(|size| size.checked_add((512 - contents_len % 512) % 512))
        .ok_or(AcquisitionError::InvalidOciResult)?;
    *archive_size = archive_size
        .checked_add(required)
        .filter(|size| *size <= IMAGE_ARCHIVE_MAX_BYTES)
        .ok_or(AcquisitionError::InvalidOciResult)?;
    let header = regular_tar_header(name, contents_len)?;
    archive.write_all(&header)?;
    let copied = copy_reader(&mut source, archive, contents_len)?;
    if copied != contents_len {
        return Err(AcquisitionError::InvalidOciResult);
    }
    let padding = ((512 - contents_len % 512) % 512) as usize;
    archive.write_all(&[0_u8; 512][..padding])?;
    Ok(())
}

/// Encodes one deterministic regular-file ustar header.
fn regular_tar_header(name: &str, contents_len: u64) -> Result<[u8; 512], AcquisitionError> {
    if !name.is_ascii() || name.len() > 100 {
        return Err(AcquisitionError::InvalidOciResult);
    }
    let mut header = [0_u8; 512];
    header[..name.len()].copy_from_slice(name.as_bytes());
    write_tar_octal(&mut header[100..108], 0o600)?;
    write_tar_octal(&mut header[108..116], 0)?;
    write_tar_octal(&mut header[116..124], 0)?;
    write_tar_octal(&mut header[124..136], contents_len)?;
    write_tar_octal(&mut header[136..148], 0)?;
    header[148..156].fill(b' ');
    header[156] = b'0';
    header[257..263].copy_from_slice(b"ustar\0");
    header[263..265].copy_from_slice(b"00");
    let checksum = header.iter().map(|byte| u64::from(*byte)).sum::<u64>();
    let checksum = format!("{checksum:06o}\0 ");
    if checksum.len() != 8 {
        return Err(AcquisitionError::InvalidOciResult);
    }
    header[148..156].copy_from_slice(checksum.as_bytes());
    Ok(header)
}

/// Encodes one bounded ustar numeric field.
fn write_tar_octal(field: &mut [u8], value: u64) -> Result<(), AcquisitionError> {
    let encoded = format!("{value:0width$o}\0", width = field.len() - 1);
    if encoded.len() != field.len() {
        return Err(AcquisitionError::InvalidOciResult);
    }
    field.copy_from_slice(encoded.as_bytes());
    Ok(())
}

struct TarHeader {
    name: String,
    size: u64,
    regular: bool,
}

/// Reads one bounded regular member while seeking past all unrelated payloads.
fn read_bounded_tar_member<R: Read + Seek>(
    archive: &mut R,
    wanted: &str,
    limit: usize,
) -> Result<Option<Vec<u8>>, AcquisitionError> {
    archive.seek(SeekFrom::Start(0))?;
    let mut found = None;
    while let Some(header) = next_tar_header(archive)? {
        if header.name == wanted {
            if found.is_some() || !header.regular || header.size > limit as u64 {
                return Err(AcquisitionError::InvalidOciResult);
            }
            let capacity =
                usize::try_from(header.size).map_err(|_| AcquisitionError::InvalidOciResult)?;
            let mut contents = Vec::with_capacity(capacity);
            read_member_stream(archive, header.size, |chunk| {
                contents.extend_from_slice(chunk);
                Ok(())
            })?;
            found = Some(contents);
        } else {
            read_member_stream(archive, header.size, |_| Ok(()))?;
        }
        seek_tar_padding(archive, header.size)?;
    }
    Ok(found)
}

/// Parses one validated ustar header and leaves the reader at member data.
fn next_tar_header<R: Read>(archive: &mut R) -> Result<Option<TarHeader>, AcquisitionError> {
    let mut header = [0_u8; 512];
    let first = archive.read(&mut header[..1])?;
    if first == 0 {
        return Err(AcquisitionError::InvalidOciResult);
    }
    read_archive_exact(archive, &mut header[1..])?;
    if header.iter().all(|byte| *byte == 0) {
        let mut second = [0_u8; 512];
        read_archive_exact(archive, &mut second)?;
        if second.iter().any(|byte| *byte != 0) {
            return Err(AcquisitionError::InvalidOciResult);
        }
        let mut trailing = [0_u8; ARCHIVE_CHUNK_BYTES];
        loop {
            let read = archive.read(&mut trailing)?;
            if read == 0 {
                break;
            }
            if trailing[..read].iter().any(|byte| *byte != 0) {
                return Err(AcquisitionError::InvalidOciResult);
            }
        }
        return Ok(None);
    }
    let stored_checksum = tar_octal(&header[148..156])?;
    let mut checksum_header = header;
    checksum_header[148..156].fill(b' ');
    let actual_checksum: u64 = checksum_header.iter().map(|byte| u64::from(*byte)).sum();
    if stored_checksum != actual_checksum {
        return Err(AcquisitionError::InvalidOciResult);
    }
    let name = tar_text(&header[0..100])?;
    let prefix = tar_text(&header[345..500])?;
    let name = if prefix.is_empty() {
        name
    } else {
        format!("{prefix}/{name}")
    };
    if name.is_empty()
        || Path::new(&name).is_absolute()
        || Path::new(&name)
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(AcquisitionError::InvalidOciResult);
    }
    let size = tar_octal(&header[124..136])?;
    if size > IMAGE_ARCHIVE_MAX_BYTES {
        return Err(AcquisitionError::InvalidOciResult);
    }
    let regular = matches!(header[156], 0 | b'0');
    if !regular && header[156] != b'5' {
        return Err(AcquisitionError::InvalidOciResult);
    }
    Ok(Some(TarHeader {
        name,
        size,
        regular,
    }))
}

fn tar_octal(bytes: &[u8]) -> Result<u64, AcquisitionError> {
    let value = tar_text(bytes)?;
    let value = value.trim();
    if value.is_empty() || !value.bytes().all(|byte| matches!(byte, b'0'..=b'7')) {
        return Err(AcquisitionError::InvalidOciResult);
    }
    u64::from_str_radix(value, 8).map_err(|_| AcquisitionError::InvalidOciResult)
}

fn read_member_stream<R: Read>(
    reader: &mut R,
    size: u64,
    mut consume: impl FnMut(&[u8]) -> Result<(), AcquisitionError>,
) -> Result<(), AcquisitionError> {
    let mut remaining = size;
    let mut buffer = [0_u8; ARCHIVE_CHUNK_BYTES];
    while remaining > 0 {
        let chunk = usize::try_from(remaining.min(ARCHIVE_CHUNK_BYTES as u64))
            .map_err(|_| AcquisitionError::InvalidOciResult)?;
        read_archive_exact(reader, &mut buffer[..chunk])?;
        consume(&buffer[..chunk])?;
        remaining -= chunk as u64;
    }
    Ok(())
}

fn read_archive_exact<R: Read>(reader: &mut R, buffer: &mut [u8]) -> Result<(), AcquisitionError> {
    reader.read_exact(buffer).map_err(|error| {
        if error.kind() == io::ErrorKind::UnexpectedEof {
            AcquisitionError::InvalidOciResult
        } else {
            AcquisitionError::Io
        }
    })
}

fn seek_tar_padding<R: Read>(reader: &mut R, size: u64) -> Result<(), AcquisitionError> {
    let padding = (512 - size % 512) % 512;
    read_member_stream(reader, padding, |_| Ok(()))
}

fn copy_reader<R: Read, W: Write>(
    source: &mut R,
    destination: &mut W,
    size: u64,
) -> Result<u64, AcquisitionError> {
    let mut copied = 0_u64;
    let mut buffer = [0_u8; ARCHIVE_CHUNK_BYTES];
    while copied < size {
        let chunk = usize::try_from((size - copied).min(ARCHIVE_CHUNK_BYTES as u64))
            .map_err(|_| AcquisitionError::InvalidOciResult)?;
        let read = source.read(&mut buffer[..chunk])?;
        if read == 0 {
            return Err(AcquisitionError::InvalidOciResult);
        }
        destination.write_all(&buffer[..read])?;
        copied += read as u64;
    }
    let mut extra = [0_u8; 1];
    if source.read(&mut extra)? != 0 {
        return Err(AcquisitionError::InvalidOciResult);
    }
    Ok(copied)
}

/// Parses a NUL-terminated UTF-8 tar header field.
fn tar_text(bytes: &[u8]) -> Result<String, AcquisitionError> {
    let end = bytes
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(bytes.len());
    String::from_utf8(bytes[..end].to_vec()).map_err(|_| AcquisitionError::InvalidOciResult)
}

fn sync_dir(path: &Path) -> Result<(), AcquisitionError> {
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?
        .sync_all()?;
    Ok(())
}

fn read_bounded_regular_utf8(path: &Path, limit: usize) -> Result<String, AcquisitionError> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > limit as u64 {
        return Err(AcquisitionError::InvalidOciResult);
    }
    read_bounded_utf8(&mut file, metadata.len(), limit)
}

/// Reads one bounded regular UTF-8 file before an absolute deadline.
fn read_bounded_regular_utf8_before(
    path: &Path,
    limit: usize,
    deadline: Instant,
) -> Result<String, AcquisitionError> {
    ensure_before(deadline)?;
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    ensure_before(deadline)?;
    let metadata = file.metadata()?;
    ensure_before(deadline)?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > limit as u64 {
        return Err(AcquisitionError::InvalidOciResult);
    }
    let mut bounded = DeadlineReader::new(&mut file, deadline);
    read_bounded_utf8(&mut bounded, metadata.len(), limit)
}

/// Reads an already-sized bounded UTF-8 document from its current position.
fn read_bounded_utf8<R: Read>(
    reader: &mut R,
    size: u64,
    limit: usize,
) -> Result<String, AcquisitionError> {
    let capacity = usize::try_from(size).map_err(|_| AcquisitionError::InvalidOciResult)?;
    let mut bytes = Vec::with_capacity(capacity);
    Read::by_ref(reader)
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() != capacity {
        return Err(AcquisitionError::InvalidOciResult);
    }
    String::from_utf8(bytes).map_err(|_| AcquisitionError::InvalidOciResult)
}

/// Produces one compact OCI archive for cross-module store tests.
#[cfg(test)]
pub(crate) fn test_oci_archive(payload: &[u8]) -> Vec<u8> {
    let config = format!(
        "{{\"architecture\":\"arm64\",\"os\":\"linux\",\"label\":\"{:x}\"}}",
        Sha256::digest(payload)
    );
    let layer = if payload.is_empty() {
        b"layer".as_slice()
    } else {
        payload
    };
    let config_digest = format!("sha256:{:x}", Sha256::digest(config.as_bytes()));
    let layer_digest = format!("sha256:{:x}", Sha256::digest(layer));
    let manifest = format!(
        "{{\"schemaVersion\":2,\"mediaType\":\"application/vnd.oci.image.manifest.v1+json\",\"config\":{{\"mediaType\":\"application/vnd.oci.image.config.v1+json\",\"digest\":\"{config_digest}\",\"size\":{}}},\"layers\":[{{\"mediaType\":\"application/vnd.oci.image.layer.v1.tar\",\"digest\":\"{layer_digest}\",\"size\":{}}}]}}",
        config.len(),
        layer.len(),
    );
    let manifest_digest = format!("sha256:{:x}", Sha256::digest(manifest.as_bytes()));
    let index = format!(
        "{{\"schemaVersion\":2,\"manifests\":[{{\"mediaType\":\"application/vnd.oci.image.manifest.v1+json\",\"digest\":\"{manifest_digest}\",\"size\":{}}}]}}",
        manifest.len(),
    );
    let mut archive = Vec::new();
    append_test_tar_member(
        &mut archive,
        "oci-layout",
        b"{\"imageLayoutVersion\":\"1.0.0\"}\n",
    );
    append_test_tar_member(&mut archive, "index.json", index.as_bytes());
    append_test_tar_member(
        &mut archive,
        &format!("blobs/sha256/{}", digest_hex(&manifest_digest).unwrap()),
        manifest.as_bytes(),
    );
    append_test_tar_member(
        &mut archive,
        &format!("blobs/sha256/{}", digest_hex(&config_digest).unwrap()),
        config.as_bytes(),
    );
    append_test_tar_member(
        &mut archive,
        &format!("blobs/sha256/{}", digest_hex(&layer_digest).unwrap()),
        layer,
    );
    archive.extend_from_slice(&[0_u8; 1024]);
    archive
}

#[cfg(test)]
fn append_test_tar_member(archive: &mut Vec<u8>, name: &str, contents: &[u8]) {
    append_test_tar_entry(archive, name, contents, b'0');
}

#[cfg(test)]
fn append_test_tar_directory(archive: &mut Vec<u8>, name: &str) {
    append_test_tar_entry(archive, name, &[], b'5');
}

#[cfg(test)]
fn append_test_tar_entry(archive: &mut Vec<u8>, name: &str, contents: &[u8], type_flag: u8) {
    let mut header = [0_u8; 512];
    header[..name.len()].copy_from_slice(name.as_bytes());
    write_tar_octal(&mut header[100..108], 0o600).unwrap();
    write_tar_octal(&mut header[108..116], 0).unwrap();
    write_tar_octal(&mut header[116..124], 0).unwrap();
    write_tar_octal(&mut header[124..136], contents.len() as u64).unwrap();
    write_tar_octal(&mut header[136..148], 0).unwrap();
    header[148..156].fill(b' ');
    header[156] = type_flag;
    header[257..263].copy_from_slice(b"ustar\0");
    header[263..265].copy_from_slice(b"00");
    let checksum = header.iter().map(|byte| u64::from(*byte)).sum::<u64>();
    header[148..156].copy_from_slice(format!("{checksum:06o}\0 ").as_bytes());
    archive.extend_from_slice(&header);
    archive.extend_from_slice(contents);
    archive.resize(archive.len() + ((512 - contents.len() % 512) % 512), 0);
}

/// Extracts one JSON string field from trusted-size generated OCI JSON.
fn json_string(input: &str, key: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(input)
        .ok()?
        .get(key)?
        .as_str()
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, BTreeSet};
    use std::fs::{self, File};
    use std::io::{self, Cursor, Read, Seek, SeekFrom};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, Instant};

    use sha2::{Digest, Sha256};

    use super::{
        AcquisitionError, AcquisitionTrigger, BUILD_MAX_OUTPUT_BYTES, BUILD_MAX_TIME,
        BuildCapabilities, BuildDefinition, BuildPlan, ImageEffectEvidence, ImageEffectRequest,
        RegistryAcquisition, archived_layout_digest, stage_registry_layout,
    };
    use crate::image_store::{ImageStore, StoreLineage};

    static NEXT_TEST_ROOT: AtomicU64 = AtomicU64::new(0);
    const EMPTY_CONTEXT_REF: &str = "build-context://empty/v1";
    const EMPTY_CONTEXT_DIGEST: &str =
        "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    struct SlowReader {
        inner: Cursor<Vec<u8>>,
        delay: Duration,
    }

    impl Read for SlowReader {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            std::thread::sleep(self.delay);
            self.inner.read(buffer)
        }
    }

    impl Seek for SlowReader {
        fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
            self.inner.seek(position)
        }
    }

    /// Returns the canonical SHA-256 image address for fixture bytes.
    fn digest(bytes: &[u8]) -> String {
        format!("sha256:{:x}", Sha256::digest(bytes))
    }

    /// Collects exact string constants used by one generated Rego equality field.
    fn exact_rego_values(policy: &str, field: &str) -> BTreeSet<String> {
        let prefix = format!("{field} == \"");
        policy
            .lines()
            .filter_map(|line| {
                let (_, value) = line.split_once(&prefix)?;
                let value = value.trim().strip_suffix('"')?;
                Some(value.to_string())
            })
            .collect()
    }

    /// Returns one process-unique temporary root without adding a fixture dependency.
    fn test_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "openkit-wp3b-{label}-{}-{}",
            std::process::id(),
            NEXT_TEST_ROOT.fetch_add(1, Ordering::Relaxed)
        ))
    }

    /// Opens one isolated retained image store.
    fn open_store(root: &Path) -> ImageStore {
        ImageStore::open(
            root.join("store"),
            root.join("epoch"),
            &[root.join("credentials")],
        )
        .expect("safe fixture store")
    }

    /// Admits one compact real OCI archive and returns its exact manifest digest.
    fn admit_archive(store: &ImageStore, root: &Path, archive: &[u8], label: &str) -> String {
        let digest = super::oci_manifest_digest(archive).expect("valid OCI fixture");
        let archive_path = root.join(format!("{label}.oci.tar"));
        fs::write(&archive_path, archive).expect("write OCI fixture");
        store
            .admit_oci_file(
                &digest,
                File::open(archive_path).expect("open OCI fixture"),
                StoreLineage::LocalArchive(digest.clone()),
                1,
            )
            .expect("admit OCI fixture");
        digest
    }

    /// Rewrites the first fixture header and restores its ustar checksum.
    fn rewrite_first_tar_header(archive: &mut [u8], name: &str, type_flag: u8) {
        assert!(name.len() <= 100);
        archive[..100].fill(0);
        archive[..name.len()].copy_from_slice(name.as_bytes());
        archive[156] = type_flag;
        archive[148..156].fill(b' ');
        let checksum = archive[..512]
            .iter()
            .map(|byte| u64::from(*byte))
            .sum::<u64>();
        archive[148..156].copy_from_slice(format!("{checksum:06o}\0 ").as_bytes());
    }

    /// Replaces one fixture member while preserving a complete bounded ustar archive.
    fn replace_tar_member(archive: &[u8], wanted: &str, replacement: &[u8]) -> Vec<u8> {
        let mut input = Cursor::new(archive);
        let mut output = Vec::new();
        let mut replaced = false;
        while let Some(header) = super::next_tar_header(&mut input).expect("valid fixture header") {
            let mut contents = Vec::new();
            super::read_member_stream(&mut input, header.size, |chunk| {
                contents.extend_from_slice(chunk);
                Ok(())
            })
            .expect("read fixture member");
            super::seek_tar_padding(&mut input, header.size).expect("fixture padding");
            if header.name == wanted {
                assert!(!replaced, "fixture member is unique");
                super::append_test_tar_entry(&mut output, wanted, replacement, b'0');
                replaced = true;
            } else {
                super::append_test_tar_entry(
                    &mut output,
                    &header.name,
                    &contents,
                    if header.regular { b'0' } else { b'5' },
                );
            }
        }
        assert!(replaced, "fixture member exists");
        output.extend_from_slice(&[0_u8; 1024]);
        output
    }

    /// Returns one accepted build definition using the exact supplied Dockerfile.
    fn build_definition(dockerfile: String) -> BuildDefinition {
        BuildDefinition {
            context_ref: EMPTY_CONTEXT_REF.into(),
            context_digest: EMPTY_CONTEXT_DIGEST.into(),
            dockerfile,
            arguments: vec![],
            egress_grants: BTreeSet::from(["registry.npmjs.org".to_string()]),
            time_limit: Duration::from_secs(600),
            output_limit_bytes: 1024,
            layer_limit: 4,
        }
    }

    /// Returns every regular file in one generated OCI layout as a relative path.
    fn layout_files(root: &Path) -> BTreeSet<String> {
        fn visit(root: &Path, directory: &Path, files: &mut BTreeSet<String>) {
            for entry in fs::read_dir(directory).expect("read OCI layout directory") {
                let path = entry.expect("read OCI layout entry").path();
                if path.is_dir() {
                    visit(root, &path, files);
                } else {
                    files.insert(
                        path.strip_prefix(root)
                            .expect("layout-relative path")
                            .to_string_lossy()
                            .into_owned(),
                    );
                }
            }
        }

        let mut files = BTreeSet::new();
        visit(root, root, &mut files);
        files
    }

    /// Reads one top-level JSON string field without constraining whitespace or ordering.
    fn json_string_field<'a>(document: &'a str, field: &str) -> Option<&'a str> {
        let marker = format!("\"{field}\"");
        let (_, tail) = document.split_once(&marker)?;
        let (_, tail) = tail.split_once(':')?;
        let tail = tail.trim_start().strip_prefix('"')?;
        tail.split_once('"').map(|(value, _)| value)
    }

    /// Builds raw image-manifest bytes whose formatting must survive staging unchanged.
    fn raw_image_manifest(
        media_type: &str,
        config_digest: &str,
        config_size: usize,
        layer_digest: &str,
        layer_size: usize,
    ) -> Vec<u8> {
        format!(
            "{{\n  \"schemaVersion\": 2,\n  \"mediaType\": \"{media_type}\",\n  \"config\": {{ \"mediaType\": \"application/vnd.oci.image.config.v1+json\", \"digest\": \"{config_digest}\", \"size\": {config_size} }},\n  \"layers\": [{{ \"mediaType\": \"application/vnd.oci.image.layer.v1.tar\", \"digest\": \"{layer_digest}\", \"size\": {layer_size} }}]\n}}"
        )
        .into_bytes()
    }

    #[test]
    fn wp3b_acquisition_accepts_only_two_triggers_and_declared_digest_registries() {
        assert_eq!(
            AcquisitionTrigger::parse("deployment-maintenance"),
            Ok(AcquisitionTrigger::DeploymentMaintenance)
        );
        assert_eq!(
            AcquisitionTrigger::parse("authorized-attempt"),
            Ok(AcquisitionTrigger::AuthorizedAttempt)
        );
        for rejected in ["sandbox", "worker", "gateway", "backend", "readiness", ""] {
            assert!(
                AcquisitionTrigger::parse(rejected).is_err(),
                "accepted {rejected}"
            );
        }

        let content = b"registry image archive";
        let exact_digest = digest(content);
        let declared = BTreeSet::from(["docker.io".to_string(), "ghcr.io".to_string()]);
        for reference in [
            format!("docker.io/library/alpine@{exact_digest}"),
            format!("ghcr.io/openkit/worker@{exact_digest}"),
        ] {
            let acquisition = RegistryAcquisition::validate(
                AcquisitionTrigger::AuthorizedAttempt,
                &reference,
                &declared,
            )
            .expect("declared digest reference");
            assert_eq!(
                acquisition.verify_content(content),
                Ok(exact_digest.clone())
            );
            assert_eq!(
                acquisition.verify_content(b"mismatch"),
                Err(AcquisitionError::DigestMismatch)
            );
        }

        for rejected in [
            "docker.io/library/alpine:latest".to_string(),
            "ghcr.io/openkit/worker:v1".to_string(),
            format!("quay.io/openkit/worker@{exact_digest}"),
            format!("registry.internal/openkit/worker@{exact_digest}"),
        ] {
            assert!(
                RegistryAcquisition::validate(
                    AcquisitionTrigger::AuthorizedAttempt,
                    &rejected,
                    &declared,
                )
                .is_err(),
                "accepted undeclared or mutable reference {rejected}"
            );
        }
    }

    #[test]
    fn wp3b_registry_staging_preserves_manifest_and_fails_before_admission() {
        let declared = BTreeSet::from(["docker.io".to_string(), "ghcr.io".to_string()]);
        let placeholder_digest = digest(b"placeholder");
        for rejected in [
            "docker.io/library/alpine:latest".to_string(),
            format!("ghcr.io/openkit/worker?token=secret@{placeholder_digest}"),
            format!("ghcr.io/user:secret@openkit/worker@{placeholder_digest}"),
            format!("registry.internal/openkit/worker@{placeholder_digest}"),
        ] {
            assert!(
                RegistryAcquisition::validate(
                    AcquisitionTrigger::AuthorizedAttempt,
                    &rejected,
                    &declared,
                )
                .is_err(),
                "accepted tag, credentials, or private registry: {rejected}"
            );
        }

        let root = test_root("registry-staging");
        let backend_canary = root.join("epoch-backend/canary");
        let store_canary = root.join("image-store/canary");
        fs::create_dir_all(backend_canary.parent().expect("backend canary parent"))
            .expect("create backend canary parent");
        fs::create_dir_all(store_canary.parent().expect("store canary parent"))
            .expect("create store canary parent");
        fs::write(&backend_canary, b"not-called").expect("write backend canary");
        fs::write(&store_canary, b"not-admitted").expect("write store canary");

        let config = br#"{"architecture":"amd64","os":"linux"}"#;
        let layer = b"exact compressed layer bytes";
        let config_digest = digest(config);
        let layer_digest = digest(layer);
        for (index, (reference_name, media_type)) in [
            (
                "docker.io/library/alpine",
                "application/vnd.docker.distribution.manifest.v2+json",
            ),
            (
                "ghcr.io/openkit/worker",
                "application/vnd.oci.image.manifest.v1+json",
            ),
        ]
        .into_iter()
        .enumerate()
        {
            let raw_manifest = raw_image_manifest(
                media_type,
                &config_digest,
                config.len(),
                &layer_digest,
                layer.len(),
            );
            let manifest_digest = digest(&raw_manifest);
            let acquisition = RegistryAcquisition::validate(
                AcquisitionTrigger::AuthorizedAttempt,
                &format!("{reference_name}@{manifest_digest}"),
                &declared,
            )
            .expect("anonymous exact-digest public-registry acquisition");
            let layout = root.join(format!("success-{index}"));
            stage_registry_layout(
                &acquisition,
                &raw_manifest,
                &[
                    (config_digest.as_str(), config.as_slice()),
                    (layer_digest.as_str(), layer.as_slice()),
                ],
                &layout,
            )
            .expect("verified image manifest stages as an OCI layout");

            let manifest_hex = manifest_digest
                .strip_prefix("sha256:")
                .expect("canonical manifest digest");
            assert_eq!(
                fs::read(layout.join(format!("blobs/sha256/{manifest_hex}")))
                    .expect("read staged manifest"),
                raw_manifest,
                "registry manifest bytes were reserialized"
            );
            assert_eq!(
                layout_files(&layout),
                BTreeSet::from([
                    "oci-layout".to_string(),
                    "index.json".to_string(),
                    format!("blobs/sha256/{manifest_hex}"),
                    format!(
                        "blobs/sha256/{}",
                        config_digest.strip_prefix("sha256:").unwrap()
                    ),
                    format!(
                        "blobs/sha256/{}",
                        layer_digest.strip_prefix("sha256:").unwrap()
                    ),
                ])
            );
            let index_document =
                fs::read_to_string(layout.join("index.json")).expect("read OCI index");
            assert_eq!(
                json_string_field(&index_document, "digest"),
                Some(manifest_digest.as_str())
            );
            assert_eq!(index_document.matches("\"digest\"").count(), 1);
            let descriptor_sizes = BTreeMap::from([
                (config_digest.clone(), config.len() as u64),
                (layer_digest.clone(), layer.len() as u64),
            ]);
            assert_eq!(
                archived_layout_digest(&layout, &manifest_digest, &descriptor_sizes),
                Ok(manifest_digest.clone()),
                "archive verifier did not select manifests[0].digest"
            );

            if index == 1 {
                let oci_index_media_type = "application/vnd.oci.image.index.v1+json";
                let standard_descriptor = format!(
                    "{{\"mediaType\":\"{media_type}\",\"digest\":\"{manifest_digest}\",\"size\":{},\"annotations\":{{\"org.opencontainers.image.created\":\"2026-08-09T02:55:29Z\"}},\"platform\":{{\"architecture\":\"arm64\",\"os\":\"linux\"}}}}",
                    raw_manifest.len()
                );
                let standard_index = format!(
                    "{{\"schemaVersion\":2,\"mediaType\":\"{oci_index_media_type}\",\"manifests\":[{standard_descriptor}]}}"
                );
                fs::write(layout.join("index.json"), &standard_index)
                    .expect("replace stock Buildx OCI index fixture");
                assert_eq!(
                    archived_layout_digest(&layout, &manifest_digest, &descriptor_sizes),
                    Ok(manifest_digest.clone()),
                    "archive verifier rejected standard OCI index fields"
                );

                let descriptor = format!(
                    "{{\"mediaType\":\"{media_type}\",\"digest\":\"{manifest_digest}\",\"size\":{}}}",
                    raw_manifest.len()
                );
                let mismatch = digest(b"different top manifest");
                for invalid_index in [
                    format!(
                        "{{\"schemaVersion\":3,\"mediaType\":\"{oci_index_media_type}\",\"manifests\":[{standard_descriptor}]}}"
                    ),
                    format!(
                        "{{\"schemaVersion\":2,\"mediaType\":\"application/vnd.docker.distribution.manifest.list.v2+json\",\"manifests\":[{standard_descriptor}]}}"
                    ),
                    format!(
                        "{{\"schemaVersion\":2,\"mediaType\":\"{oci_index_media_type}\",\"manifests\":[{standard_descriptor}],\"unknown\":true}}"
                    ),
                    format!(
                        "{{\"schemaVersion\":2,\"mediaType\":\"{oci_index_media_type}\",\"manifests\":[]}}"
                    ),
                    format!(
                        "{{\"schemaVersion\":2,\"mediaType\":\"{oci_index_media_type}\",\"manifests\":[{descriptor},{descriptor}]}}"
                    ),
                    format!(
                        "{{\"schemaVersion\":2,\"mediaType\":\"{oci_index_media_type}\",\"manifests\":[{{\"mediaType\":\"application/vnd.oci.image.index.v1+json\",\"digest\":\"{manifest_digest}\",\"size\":{}}}]}}",
                        raw_manifest.len()
                    ),
                    format!(
                        "{{\"schemaVersion\":2,\"mediaType\":\"{oci_index_media_type}\",\"manifests\":[{{\"mediaType\":\"{media_type}\",\"digest\":\"{manifest_digest}\",\"size\":{},\"unknown\":true}}]}}",
                        raw_manifest.len()
                    ),
                    format!(
                        "{{\"schemaVersion\":2,\"mediaType\":\"{oci_index_media_type}\",\"manifests\":[{{\"mediaType\":\"{media_type}\",\"digest\":\"{mismatch}\",\"size\":{}}}]}}",
                        raw_manifest.len()
                    ),
                    format!(
                        "{{\"schemaVersion\":2,\"mediaType\":\"{oci_index_media_type}\",\"manifests\":[{{\"mediaType\":\"{media_type}\",\"digest\":\"{manifest_digest}\",\"size\":{}}}]}}",
                        raw_manifest.len() + 1
                    ),
                ] {
                    fs::write(layout.join("index.json"), invalid_index)
                        .expect("replace invalid OCI index fixture");
                    assert_eq!(
                        archived_layout_digest(&layout, &manifest_digest, &descriptor_sizes),
                        Err(AcquisitionError::InvalidOciResult)
                    );
                }

                fs::write(layout.join("index.json"), standard_index)
                    .expect("restore standard OCI index fixture");
                fs::write(
                    layout.join(format!("blobs/sha256/{manifest_hex}")),
                    b"mismatched manifest blob",
                )
                .expect("replace mismatched manifest blob fixture");
                assert_eq!(
                    archived_layout_digest(&layout, &manifest_digest, &descriptor_sizes),
                    Err(AcquisitionError::InvalidOciResult)
                );
            }
            assert_eq!(fs::read(&backend_canary).unwrap(), b"not-called");
            assert_eq!(fs::read(&store_canary).unwrap(), b"not-admitted");
        }

        let valid_manifest = raw_image_manifest(
            "application/vnd.oci.image.manifest.v1+json",
            &config_digest,
            config.len(),
            &layer_digest,
            layer.len(),
        );
        let mut failure_index = 0_u8;
        let mut assert_rejected = |raw_manifest: Vec<u8>, blobs: Vec<(String, Vec<u8>)>| {
            let manifest_digest = digest(&raw_manifest);
            let acquisition = RegistryAcquisition::validate(
                AcquisitionTrigger::AuthorizedAttempt,
                &format!("ghcr.io/openkit/worker@{manifest_digest}"),
                &declared,
            )
            .expect("exact digest failure fixture");
            let layout = root.join(format!("failure-{failure_index}"));
            failure_index += 1;
            let blob_refs = blobs
                .iter()
                .map(|(blob_digest, bytes)| (blob_digest.as_str(), bytes.as_slice()))
                .collect::<Vec<_>>();
            assert!(
                stage_registry_layout(&acquisition, &raw_manifest, &blob_refs, &layout).is_err()
            );
            assert!(!layout.exists(), "failed staging left partial OCI data");
            assert_eq!(fs::read(&backend_canary).unwrap(), b"not-called");
            assert_eq!(fs::read(&store_canary).unwrap(), b"not-admitted");
        };

        for index_media_type in [
            "application/vnd.oci.image.index.v1+json",
            "application/vnd.docker.distribution.manifest.list.v2+json",
        ] {
            assert_rejected(
                format!(
                    "{{\"schemaVersion\":2,\"mediaType\":\"{index_media_type}\",\"manifests\":[]}}"
                )
                .into_bytes(),
                vec![],
            );
        }
        assert_rejected(
            valid_manifest.clone(),
            vec![(layer_digest.clone(), layer.to_vec())],
        );
        assert_rejected(
            valid_manifest.clone(),
            vec![
                (config_digest.clone(), b"wrong config".to_vec()),
                (layer_digest.clone(), layer.to_vec()),
            ],
        );
        assert_rejected(
            raw_image_manifest(
                "application/vnd.oci.image.manifest.v1+json",
                &config_digest,
                config.len() + 1,
                &layer_digest,
                layer.len(),
            ),
            vec![
                (config_digest.clone(), config.to_vec()),
                (layer_digest.clone(), layer.to_vec()),
            ],
        );
        assert_rejected(
            valid_manifest.clone(),
            vec![(config_digest.clone(), config.to_vec())],
        );
        assert_rejected(
            valid_manifest.clone(),
            vec![
                (config_digest.clone(), config.to_vec()),
                (layer_digest.clone(), b"wrong layer".to_vec()),
            ],
        );
        assert_rejected(
            raw_image_manifest(
                "application/vnd.oci.image.manifest.v1+json",
                &config_digest,
                config.len(),
                &layer_digest,
                layer.len() + 1,
            ),
            vec![
                (config_digest, config.to_vec()),
                (layer_digest, layer.to_vec()),
            ],
        );

        fs::remove_dir_all(root).expect("remove registry staging fixture");
    }

    #[test]
    fn wp3b_build_is_fixed_bounded_contained_backend_input() {
        assert_eq!(BUILD_MAX_TIME, Duration::from_secs(30 * 60));
        assert_eq!(BUILD_MAX_OUTPUT_BYTES, 20 * 1024 * 1024 * 1024);
        let definition = BuildDefinition {
            context_ref: EMPTY_CONTEXT_REF.into(),
            context_digest: EMPTY_CONTEXT_DIGEST.into(),
            dockerfile: "FROM scratch\nCOPY app /app\n".into(),
            arguments: vec![("TARGET".into(), "release".into())],
            egress_grants: BTreeSet::from([
                "registry.npmjs.org".to_string(),
                "https://example.com/allowed".to_string(),
                "https://files.pythonhosted.org:443/packages/".to_string(),
            ]),
            time_limit: Duration::from_secs(600),
            output_limit_bytes: 1024,
            layer_limit: 4,
        };
        let registries = BTreeSet::from(["docker.io".to_string(), "ghcr.io".to_string()]);
        let socket = Path::new("/run/openkit/nanohost/epoch/docker.sock");
        let build_root = Path::new("/run/openkit/nanohost/acquisitions/build-1");
        let plan = BuildPlan::validate(definition.clone(), &registries, socket, build_root)
            .expect("bounded build plan");

        assert_eq!(plan.program(), Path::new("/usr/bin/docker"));
        assert_eq!(
            plan.env(),
            &[(
                "DOCKER_HOST".to_string(),
                format!("unix://{}", socket.display()),
            )]
        );
        let source = include_str!("image_acquisition.rs");
        let probe_source = source
            .split_once("pub fn probe(")
            .expect("BuildCapabilities probe source")
            .1
            .split_once("/// Direct, fixed Buildx execution plan")
            .expect("end of BuildCapabilities implementation")
            .0;
        assert_eq!(probe_source.matches(".env(\"DOCKER_HOST\"").count(), 2);
        assert_eq!(
            probe_source
                .matches(".env_remove(\"BUILDX_BUILDER\")")
                .count(),
            2,
            "both Buildx capability commands must remove inherited builder selection"
        );
        let execute_source = source
            .split_once("pub fn execute<F>(")
            .expect("BuildPlan execute source")
            .1
            .split_once("pub fn execute_and_admit(")
            .expect("end of BuildPlan execute")
            .0;
        assert!(execute_source.contains(".envs(self.env.iter().cloned())"));
        assert!(
            execute_source.contains(".env_remove(\"BUILDX_BUILDER\")"),
            "the Buildx build command must remove inherited builder selection"
        );
        let current_dir = execute_source
            .find(".current_dir(&self.build_root)")
            .expect("Buildx policy cwd");
        let spawn = execute_source
            .find(".spawn()")
            .expect("direct Buildx spawn");
        assert!(current_dir < spawn);
        let root_create = execute_source
            .find("create_private_dir(&self.build_root)")
            .expect("exclusive private build root creation");
        let context_create = execute_source
            .find("create_private_dir(&context_root)")
            .expect("exclusive zero-entry context creation");
        let zero_entry_check = execute_source
            .find("fs::read_dir(&context_root)")
            .expect("empty context proof before Solve");
        let capability_probe = execute_source
            .find("BuildCapabilities::probe")
            .expect("pre-Solve capability probe");
        assert!(root_create < context_create);
        assert!(context_create < zero_entry_check);
        assert!(zero_entry_check < capability_probe);
        assert!(capability_probe < spawn);
        assert!(plan.args().windows(2).any(|args| {
            args[0] == "--file" && args[1] == build_root.join("Dockerfile").display().to_string()
        }));
        let context_arg = build_root.join("context").display().to_string();
        assert_eq!(plan.args().last(), Some(&context_arg));
        assert!(execute_source.contains("&self.build_root.join(\"policy.rego\")"));
        assert!(!execute_source.contains("context_root.join(\"policy.rego\")"));
        assert!(execute_source.contains("fs::remove_dir_all(&self.build_root)"));
        assert!(!plan.uses_shell());
        assert!(!plan.uses_host_network());
        assert!(!plan.uses_host_mount());
        assert!(!plan.publishes());
        assert_eq!(
            plan.allowed_egress(),
            &BTreeSet::from([
                "docker.io".to_string(),
                "ghcr.io".to_string(),
                "registry.npmjs.org".to_string(),
                "https://example.com/allowed".to_string(),
                "https://files.pythonhosted.org:443/packages/".to_string(),
            ])
        );
        assert!(plan.sandbox_egress_projection().is_empty());
        assert_eq!(plan.lineage(), definition.lineage());
        assert_ne!(
            plan.lineage(),
            BuildDefinition {
                context_ref: "build-context://empty/v2".into(),
                ..definition.clone()
            }
            .lineage()
        );
        let canonicalized_definition = BuildDefinition {
            egress_grants: BTreeSet::from([
                "registry.npmjs.org:443".to_string(),
                "https://example.com:443/allowed".to_string(),
                "https://files.pythonhosted.org:443/packages/".to_string(),
            ]),
            ..definition.clone()
        };
        assert_ne!(plan.lineage(), canonicalized_definition.lineage());
        assert_eq!(
            plan.args()
                .iter()
                .take(2)
                .map(String::as_str)
                .collect::<Vec<_>>(),
            vec!["buildx", "build"]
        );
        let policy_value = plan
            .args()
            .windows(2)
            .find_map(|args| (args[0] == "--policy").then_some(args[1].as_str()))
            .expect("strict generated Buildx policy");
        assert_eq!(
            policy_value,
            "filename=cwd://policy.rego,reset=true,strict=true"
        );
        assert!(!policy_value.contains(&build_root.display().to_string()));
        assert!(
            !plan
                .args()
                .iter()
                .any(|arg| arg.ends_with("/context/policy.rego"))
        );
        assert!(plan.args().windows(2).any(|args| {
            args[0] == "--output"
                && args[1]
                    == format!(
                        "type=oci,dest={}",
                        build_root.join("result.oci.tar").display()
                    )
        }));
        let argv = plan.args().join(" ");
        for forbidden in [
            "--network host",
            "--mount type=bind",
            "--allow",
            "--builder",
            "--load",
            "--push",
            "--tag",
            " -t ",
            "--secret",
            "--ssh",
            "nanohost-token",
            "gateway-auth",
            "docker.sock:/",
        ] {
            assert!(!argv.contains(forbidden), "build plan contains {forbidden}");
        }
        assert!(!argv.contains(&definition.dockerfile));

        let policy = plan.policy_contents();
        assert!(policy.contains("default allow := false"));
        assert!(policy.contains("input.env.capsRequest"));
        assert!(policy.contains("\"exec.proxy\": true"));
        assert_eq!(policy.matches("\"exec.proxy\": true").count(), 1);
        assert_eq!(
            exact_rego_values(policy, "input.http.host"),
            BTreeSet::from(["registry.npmjs.org:443".to_string()])
        );
        assert!(policy.contains("docker.io:443"));
        assert!(policy.contains("ghcr.io:443"));
        assert_eq!(
            exact_rego_values(policy, "input.http.url"),
            BTreeSet::from([
                "https://example.com:443/allowed".to_string(),
                "https://files.pythonhosted.org:443/packages/".to_string(),
            ])
        );
        for forbidden in [
            "endswith(",
            "contains(",
            "glob.match",
            "regex.match",
            "http://",
        ] {
            assert!(
                !policy.contains(forbidden),
                "policy contains widening {forbidden}"
            );
        }
    }

    #[test]
    fn retained_exact_parents_use_one_private_native_context_and_missing_falls_back() {
        let root = test_root("retained-parent");
        let store = open_store(&root);
        let mut archive = super::test_oci_archive(b"retained-parent-layer");
        archive.truncate(archive.len() - 1024);
        super::append_test_tar_directory(&mut archive, "blobs/");
        super::append_test_tar_directory(&mut archive, "blobs/sha256/");
        super::append_test_tar_member(&mut archive, "manifest.json", b"compatibility-only");
        archive.extend_from_slice(&[0_u8; 1024]);
        let retained_digest = admit_archive(&store, &root, &archive, "retained-parent");
        let missing_digest = digest(b"definitely missing parent");
        let first_reference = format!("docker.io/openkit/base@{retained_digest}");
        let alias_reference = format!("docker.io/openkit/base-alias@{retained_digest}");
        let missing_reference = format!("docker.io/openkit/missing@{missing_digest}");
        let dockerfile = format!(
            "FROM {first_reference} AS first\nFROM {alias_reference} AS second\nFROM {first_reference} AS repeated\nFROM {missing_reference}\n"
        );
        let registries = BTreeSet::from(["docker.io".to_string()]);
        let build_root = root.join("build");
        let plan = BuildPlan::validate(
            build_definition(dockerfile.clone()),
            &registries,
            Path::new("/run/openkit/nanohost/epoch/docker.sock"),
            &build_root,
        )
        .expect("factory build plan");
        super::create_private_dir(&build_root).expect("private build root");
        let mut bound = Vec::new();
        let mut bind = |digest: &str,
                        alias: &str,
                        mut archive: File,
                        deadline: Instant|
         -> Result<(), AcquisitionError> {
            assert!(deadline > Instant::now());
            let verified = super::verify_oci_archive(&mut archive, Some(digest))?;
            super::verify_raw_import_names(&mut archive)?;
            bound.push((
                digest.to_string(),
                alias.to_string(),
                verified.config_digest,
            ));
            Ok(())
        };
        let args = plan
            .prepare_build_args(
                &store,
                super::IMAGE_ARCHIVE_MAX_BYTES,
                Instant::now() + Duration::from_secs(60),
                &mut bind,
            )
            .expect("retained parent projection");

        assert_eq!(plan.definition.dockerfile, dockerfile);
        let retained_alias = super::retained_parent_alias(&retained_digest).expect("private alias");
        assert_eq!(bound.len(), 1, "one retained digest must bind once");
        assert_eq!(bound[0].0, retained_digest);
        assert_eq!(bound[0].1, retained_alias);
        let context_specs = args
            .windows(2)
            .filter_map(|pair| (pair[0] == "--build-context").then_some(pair[1].clone()))
            .collect::<BTreeSet<_>>();
        assert_eq!(
            context_specs,
            BTreeSet::from([
                format!("{first_reference}=docker-image://{retained_alias}"),
                format!("{alias_reference}=docker-image://{retained_alias}"),
            ])
        );
        assert!(
            context_specs
                .iter()
                .all(|context| !context.starts_with(&missing_reference))
        );
        assert_eq!(
            fs::read_dir(build_root.join("parents"))
                .expect("normalized parent archives")
                .count(),
            1,
            "same retained digest must be normalized once"
        );
        let policy = plan.policy_contents();
        assert!(policy.contains(&format!("input.image.ref == \"{retained_alias}\"")));
        assert!(policy.contains(&format!("input.image.checksum == \"{retained_digest}\"")));
        assert!(!policy.contains("input.image.host == \"openkit.invalid:443\""));
        fs::remove_dir_all(root).expect("remove retained-parent fixture");
    }

    #[test]
    fn corrupt_retained_parent_fails_without_registry_fallback() {
        let root = test_root("corrupt-parent");
        let store = open_store(&root);
        let archive = super::test_oci_archive(b"corrupt-parent-layer");
        let retained_digest = admit_archive(&store, &root, &archive, "corrupt-parent");
        let retained_path = root.join("store/content").join(
            retained_digest
                .strip_prefix("sha256:")
                .expect("validated digest"),
        );
        fs::write(&retained_path, b"positive corruption").expect("corrupt retained archive");
        let build_root = root.join("build");
        let plan = BuildPlan::validate(
            build_definition(format!("FROM docker.io/openkit/base@{retained_digest}\n")),
            &BTreeSet::from(["docker.io".to_string()]),
            Path::new("/run/openkit/nanohost/epoch/docker.sock"),
            &build_root,
        )
        .expect("factory build plan");
        super::create_private_dir(&build_root).expect("private build root");
        let mut bind = |_: &str, _: &str, _: File, _: Instant| Ok(());
        assert_eq!(
            plan.prepare_build_args(
                &store,
                super::IMAGE_ARCHIVE_MAX_BYTES,
                Instant::now() + Duration::from_secs(60),
                &mut bind,
            ),
            Err(AcquisitionError::InvalidOciResult)
        );
        assert!(!build_root.join("parents").exists());
        fs::remove_dir_all(root).expect("remove corrupt-parent fixture");
    }

    #[test]
    fn retained_parent_source_aggregate_is_refused_before_first_import() {
        let root = test_root("retained-parent-source-aggregate");
        let store = open_store(&root);
        let first_archive = super::test_oci_archive(b"first-retained-parent-layer");
        let second_archive = super::test_oci_archive(b"second-retained-parent-layer");
        let first_digest = admit_archive(&store, &root, &first_archive, "first-parent");
        let second_digest = admit_archive(&store, &root, &second_archive, "second-parent");
        let build_root = root.join("build");
        let plan = BuildPlan::validate(
            build_definition(format!(
                "FROM docker.io/openkit/first@{first_digest}\nFROM docker.io/openkit/second@{second_digest}\n"
            )),
            &BTreeSet::from(["docker.io".to_string()]),
            Path::new("/run/openkit/nanohost/epoch/docker.sock"),
            &build_root,
        )
        .expect("factory build plan");
        super::create_private_dir(&build_root).expect("private build root");
        let mut imported = false;
        let mut bind = |_: &str, _: &str, _: File, _: Instant| {
            imported = true;
            Ok(())
        };
        let aggregate_limit = (first_archive.len() + second_archive.len() - 1) as u64;
        assert_eq!(
            plan.prepare_build_args(
                &store,
                aggregate_limit,
                Instant::now() + Duration::from_secs(60),
                &mut bind,
            ),
            Err(AcquisitionError::InvalidOciResult)
        );
        assert!(!imported, "source aggregate must be known before import");
        assert!(!build_root.join("parents").exists());
        fs::remove_dir_all(root).expect("remove source-aggregate fixture");
    }

    #[test]
    fn retained_parent_preparation_obeys_the_whole_build_deadline() {
        let root = test_root("retained-parent-deadline");
        let store = open_store(&root);
        let archive = super::test_oci_archive(b"deadline-parent-layer");
        let retained_digest = admit_archive(&store, &root, &archive, "deadline-parent");
        let build_root = root.join("build");
        let plan = BuildPlan::validate(
            build_definition(format!("FROM docker.io/openkit/base@{retained_digest}\n")),
            &BTreeSet::from(["docker.io".to_string()]),
            Path::new("/run/openkit/nanohost/epoch/docker.sock"),
            &build_root,
        )
        .expect("factory build plan");
        super::create_private_dir(&build_root).expect("private build root");
        let mut called = false;
        let mut bind = |_: &str, _: &str, _: File, _: Instant| {
            called = true;
            Ok(())
        };
        assert_eq!(
            plan.prepare_build_args(
                &store,
                super::IMAGE_ARCHIVE_MAX_BYTES,
                Instant::now() - Duration::from_millis(1),
                &mut bind,
            ),
            Err(AcquisitionError::Backend)
        );
        assert!(!called);
        assert!(!build_root.join("parents").exists());
        fs::remove_dir_all(root).expect("remove deadline fixture");
    }

    #[test]
    fn incomplete_retained_parent_never_becomes_registry_fallback() {
        for state in [
            "content-only",
            "staged-only",
            "staged-with-index",
            "index-only",
            "staged-index-only",
            "valid-pair-with-staged-index",
        ] {
            let root = test_root(state);
            let store = open_store(&root);
            let archive = super::test_oci_archive(state.as_bytes());
            let retained_digest = admit_archive(&store, &root, &archive, state);
            let stem = retained_digest
                .strip_prefix("sha256:")
                .expect("validated digest");
            let content_path = root.join("store/content").join(stem);
            let staged_path = root
                .join("store/content")
                .join(format!("{stem}.content.tmp"));
            let index_path = root.join("store/index").join(format!("{stem}.meta"));
            let staged_index_path = root.join("store/index").join(format!("{stem}.meta.tmp"));
            match state {
                "content-only" => fs::remove_file(&index_path).expect("remove final index"),
                "staged-only" => {
                    fs::rename(&content_path, &staged_path).expect("stage retained content");
                    fs::remove_file(&index_path).expect("remove final index");
                }
                "staged-with-index" => {
                    fs::rename(&content_path, &staged_path).expect("stage retained content");
                }
                "index-only" => fs::remove_file(&content_path).expect("remove final content"),
                "staged-index-only" => {
                    fs::remove_file(&content_path).expect("remove final content");
                    fs::rename(&index_path, &staged_index_path).expect("stage retained index");
                }
                "valid-pair-with-staged-index" => {
                    fs::copy(&index_path, &staged_index_path).expect("stage duplicate index");
                }
                _ => unreachable!(),
            }
            let content_before = fs::read(&content_path).ok();
            let staged_before = fs::read(&staged_path).ok();
            let index_before = fs::read(&index_path).ok();
            let staged_index_before = fs::read(&staged_index_path).ok();
            let build_root = root.join("build");
            let plan = BuildPlan::validate(
                build_definition(format!("FROM docker.io/openkit/base@{retained_digest}\n")),
                &BTreeSet::from(["docker.io".to_string()]),
                Path::new("/run/openkit/nanohost/epoch/docker.sock"),
                &build_root,
            )
            .expect("factory build plan");
            super::create_private_dir(&build_root).expect("private build root");
            let mut bind = |_: &str, _: &str, _: File, _: Instant| Ok(());
            assert_eq!(
                plan.prepare_build_args(
                    &store,
                    super::IMAGE_ARCHIVE_MAX_BYTES,
                    Instant::now() + Duration::from_secs(60),
                    &mut bind,
                ),
                Err(AcquisitionError::InvalidOciResult),
                "{state} must fail rather than selecting registry fallback"
            );
            assert_eq!(fs::read(&content_path).ok(), content_before);
            assert_eq!(fs::read(&staged_path).ok(), staged_before);
            assert_eq!(fs::read(&index_path).ok(), index_before);
            assert_eq!(fs::read(&staged_index_path).ok(), staged_index_before);
            assert!(!build_root.join("parents").exists());
            fs::remove_dir_all(root).expect("remove incomplete-parent fixture");
        }
    }

    #[test]
    fn retained_parent_normalization_rejects_duplicate_unsafe_and_overlimit_archives() {
        let mut duplicate = super::test_oci_archive(b"duplicate-parent-layer");
        duplicate.truncate(duplicate.len() - 1024);
        super::append_test_tar_member(&mut duplicate, "manifest.json", b"first");
        super::append_test_tar_member(&mut duplicate, "manifest.json", b"second");
        duplicate.extend_from_slice(&[0_u8; 1024]);
        let duplicate_digest = super::oci_manifest_digest(&duplicate).expect("verified graph");
        let duplicate_root = test_root("duplicate-layout");
        fs::create_dir_all(&duplicate_root).expect("duplicate root");
        let mut duplicate_archive = Cursor::new(&duplicate);
        let mut duplicate_bytes = 0;
        assert!(matches!(
            super::create_naming_neutral_oci_archive(
                &mut duplicate_archive,
                &duplicate_digest,
                &duplicate_root.join("parent.oci.tar"),
                &mut duplicate_bytes,
                super::IMAGE_ARCHIVE_MAX_BYTES,
                Instant::now() + Duration::from_secs(60),
            ),
            Err(AcquisitionError::InvalidOciResult)
        ));

        let mut unique_extras = super::test_oci_archive(b"unique-extra-parent-layer");
        unique_extras.truncate(unique_extras.len() - 1024);
        for index in 0..1024 {
            super::append_test_tar_member(
                &mut unique_extras,
                &format!("unreferenced-{index}"),
                &[],
            );
        }
        unique_extras.extend_from_slice(&[0_u8; 1024]);
        let unique_extras_digest =
            super::oci_manifest_digest(&unique_extras).expect("verified graph with extras");
        let unique_extras_root = test_root("unique-extras-layout");
        fs::create_dir_all(&unique_extras_root).expect("unique extras root");
        let mut unique_extras_bytes = 0;
        assert!(matches!(
            super::create_naming_neutral_oci_archive(
                &mut Cursor::new(&unique_extras),
                &unique_extras_digest,
                &unique_extras_root.join("parent.oci.tar"),
                &mut unique_extras_bytes,
                super::IMAGE_ARCHIVE_MAX_BYTES,
                Instant::now() + Duration::from_secs(60),
            ),
            Err(AcquisitionError::InvalidOciResult)
        ));
        for (label, name, type_flag) in [
            ("link", "oci-layout", b'2'),
            ("traversal", "../escape", b'0'),
        ] {
            let mut unsafe_archive = super::test_oci_archive(label.as_bytes());
            rewrite_first_tar_header(&mut unsafe_archive, name, type_flag);
            let unsafe_root = test_root(label);
            fs::create_dir_all(&unsafe_root).expect("unsafe root");
            let mut projected = 0;
            assert!(matches!(
                super::create_naming_neutral_oci_archive(
                    &mut Cursor::new(&unsafe_archive),
                    &digest(b"untrusted expected digest"),
                    &unsafe_root.join("parent.oci.tar"),
                    &mut projected,
                    super::IMAGE_ARCHIVE_MAX_BYTES,
                    Instant::now() + Duration::from_secs(60),
                ),
                Err(AcquisitionError::InvalidOciResult)
            ));
            fs::remove_dir_all(unsafe_root).expect("remove unsafe root");
        }

        let archive = super::test_oci_archive(b"bounded-parent-layer");
        let archive_digest = super::oci_manifest_digest(&archive).expect("valid bounded fixture");
        let complete_root = test_root("complete-layout");
        fs::create_dir_all(&complete_root).expect("complete root");
        let mut complete_bytes = 0;
        let mut normalized = super::create_naming_neutral_oci_archive(
            &mut Cursor::new(&archive),
            &archive_digest,
            &complete_root.join("parent.oci.tar"),
            &mut complete_bytes,
            super::IMAGE_ARCHIVE_MAX_BYTES,
            Instant::now() + Duration::from_secs(60),
        )
        .expect("complete retained projection");
        assert_eq!(normalized.metadata().unwrap().len(), complete_bytes);
        assert_eq!(
            super::verify_oci_archive(&mut normalized, Some(&archive_digest))
                .expect("reverified normalized graph")
                .digest,
            archive_digest
        );
        assert_eq!(super::verify_raw_import_names(&mut normalized), Ok(()));
        assert_eq!(
            super::read_bounded_tar_member(
                &mut normalized,
                "manifest.json",
                super::OCI_DOCUMENT_MAX_BYTES,
            ),
            Ok(None)
        );
        assert!(complete_bytes > 1);
        let limited_root = test_root("limited-layout");
        fs::create_dir_all(&limited_root).expect("limited root");
        let mut limited_bytes = 0;
        assert!(matches!(
            super::create_naming_neutral_oci_archive(
                &mut Cursor::new(&archive),
                &archive_digest,
                &limited_root.join("parent.oci.tar"),
                &mut limited_bytes,
                complete_bytes - 1,
                Instant::now() + Duration::from_secs(60),
            ),
            Err(AcquisitionError::InvalidOciResult)
        ));
        assert!(limited_bytes < complete_bytes);
        assert_eq!(
            fs::metadata(limited_root.join("parent.oci.tar"))
                .expect("limited normalized archive")
                .len(),
            limited_bytes
        );

        for root in [
            duplicate_root,
            unique_extras_root,
            complete_root,
            limited_root,
        ] {
            fs::remove_dir_all(root).expect("remove projection fixture");
        }
    }

    #[test]
    fn raw_import_guard_rejects_reserved_private_alias_names() {
        let mut archive = super::test_oci_archive(b"reserved-alias-import");
        archive.truncate(archive.len() - 1024);
        super::append_test_tar_member(
            &mut archive,
            "manifest.json",
            br#"[{"Config":"config","RepoTags":["openkit.invalid/retained-parent:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],"Layers":[]}]"#,
        );
        archive.extend_from_slice(&[0_u8; 1024]);

        let mut named = Cursor::new(&archive);
        assert_eq!(
            super::verify_raw_import_names(&mut named),
            Err(AcquisitionError::InvalidOciResult)
        );

        let mut neutral = Cursor::new(super::test_oci_archive(b"neutral-import"));
        assert_eq!(super::verify_raw_import_names(&mut neutral), Ok(()));

        let base = super::test_oci_archive(b"reserved-index-alias");
        let mut base_reader = Cursor::new(&base);
        let index = super::read_bounded_tar_member(
            &mut base_reader,
            "index.json",
            super::OCI_DOCUMENT_MAX_BYTES,
        )
        .expect("read fixture index")
        .expect("fixture index");
        let mut index: serde_json::Value = serde_json::from_slice(&index).expect("fixture JSON");
        let descriptor = index
            .get_mut("manifests")
            .and_then(serde_json::Value::as_array_mut)
            .and_then(|manifests| manifests.first_mut())
            .and_then(serde_json::Value::as_object_mut)
            .expect("fixture descriptor");
        descriptor.insert(
            "annotations".to_string(),
            serde_json::json!({
                "io.containerd.image.name": "openkit.invalid/retained-parent@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            }),
        );
        let index_named = replace_tar_member(
            &base,
            "index.json",
            &serde_json::to_vec(&index).expect("encode named index"),
        );
        assert_eq!(
            super::verify_raw_import_names(&mut Cursor::new(index_named)),
            Err(AcquisitionError::InvalidOciResult)
        );

        for malformed in [
            br#"{}"#.as_slice(),
            br#"[]"#.as_slice(),
            br#"[{"RepoTags":"openkit.invalid/retained-parent:latest"}]"#.as_slice(),
            br#"[{"RepoTags":[42]}]"#.as_slice(),
            br#"[{"RepoTags":["OPENKIT.invalid/retained-parent:latest"]}]"#.as_slice(),
        ] {
            let mut malformed_archive = super::test_oci_archive(b"malformed-naming");
            malformed_archive.truncate(malformed_archive.len() - 1024);
            super::append_test_tar_member(&mut malformed_archive, "manifest.json", malformed);
            malformed_archive.extend_from_slice(&[0_u8; 1024]);
            assert_eq!(
                super::verify_raw_import_names(&mut Cursor::new(malformed_archive)),
                Err(AcquisitionError::InvalidOciResult)
            );
        }
    }

    #[test]
    fn wp3b_build_rejects_missing_egress_secrets_and_excess_bounds() {
        let registries = BTreeSet::from(["docker.io".to_string()]);
        let base_digest = digest(b"accepted base image");
        let valid = BuildDefinition {
            context_ref: EMPTY_CONTEXT_REF.into(),
            context_digest: EMPTY_CONTEXT_DIGEST.into(),
            dockerfile: "FROM scratch".into(),
            arguments: vec![],
            egress_grants: BTreeSet::from(["registry.npmjs.org".to_string()]),
            time_limit: BUILD_MAX_TIME,
            output_limit_bytes: BUILD_MAX_OUTPUT_BYTES,
            layer_limit: 128,
        };
        let socket = Path::new("/run/openkit/nanohost/epoch/docker.sock");
        let build_root = test_root("build-invalid");
        for invalid in [
            BuildDefinition {
                context_ref: "workspace://build-context".into(),
                ..valid.clone()
            },
            BuildDefinition {
                context_digest: digest(b"not empty"),
                ..valid.clone()
            },
            BuildDefinition {
                egress_grants: BTreeSet::new(),
                ..valid.clone()
            },
            BuildDefinition {
                egress_grants: BTreeSet::from(["*".to_string()]),
                ..valid.clone()
            },
            BuildDefinition {
                egress_grants: BTreeSet::from(["*.example.com".to_string()]),
                ..valid.clone()
            },
            BuildDefinition {
                egress_grants: BTreeSet::from([".example.com".to_string()]),
                ..valid.clone()
            },
            BuildDefinition {
                egress_grants: BTreeSet::from(["example.com\nallow := true".to_string()]),
                ..valid.clone()
            },
            BuildDefinition {
                egress_grants: BTreeSet::from(["example.com\"\nallow := true".to_string()]),
                ..valid.clone()
            },
            BuildDefinition {
                egress_grants: BTreeSet::from(["https://example.com/*".to_string()]),
                ..valid.clone()
            },
            BuildDefinition {
                arguments: vec![("ACCESS_TOKEN".into(), "secret".into())],
                ..valid.clone()
            },
            BuildDefinition {
                time_limit: BUILD_MAX_TIME + Duration::from_secs(1),
                ..valid.clone()
            },
            BuildDefinition {
                output_limit_bytes: BUILD_MAX_OUTPUT_BYTES + 1,
                ..valid.clone()
            },
            BuildDefinition {
                layer_limit: 0,
                ..valid.clone()
            },
            BuildDefinition {
                layer_limit: 129,
                ..valid.clone()
            },
            BuildDefinition {
                dockerfile: "RUN --mount=type=bind,source=/etc,target=/host true".into(),
                ..valid.clone()
            },
            BuildDefinition {
                dockerfile: format!("FROM undeclared.example/worker@{base_digest}"),
                ..valid.clone()
            },
        ] {
            assert!(BuildPlan::validate(invalid, &registries, socket, &build_root).is_err());
            assert!(
                !build_root.exists(),
                "invalid pair created a private build root"
            );
        }

        for (registry, reference) in [
            ("docker.io", "docker.io/library/alpine"),
            ("ghcr.io", "ghcr.io/openkit/worker"),
        ] {
            assert!(
                BuildPlan::validate(
                    BuildDefinition {
                        dockerfile: format!("FROM {reference}@{base_digest}"),
                        ..valid.clone()
                    },
                    &BTreeSet::from([registry.to_string()]),
                    socket,
                    &build_root,
                )
                .is_ok(),
                "rejected declared exact-digest FROM {reference}"
            );
        }
    }

    #[test]
    fn expired_capability_deadline_spawns_no_child() {
        let root = test_root("expired-capability-deadline");
        fs::create_dir_all(&root).expect("capability deadline root");
        let canary = root.join("child-ran");
        let output = root.join("capability-output");
        let mut command = std::process::Command::new("/usr/bin/touch");
        command.arg(&canary);
        assert_eq!(
            super::bounded_command_output(
                &mut command,
                &output,
                Instant::now() - Duration::from_millis(1),
            ),
            Err(AcquisitionError::UnsupportedBuildCapability)
        );
        assert!(!canary.exists(), "expired deadline started a child");
        assert!(!output.exists(), "expired deadline created command output");
        fs::remove_dir_all(root).expect("remove capability deadline root");
    }

    #[test]
    fn archive_verification_deadline_fails_during_streaming_reads() {
        let archive = super::test_oci_archive(&vec![b'x'; super::ARCHIVE_CHUNK_BYTES * 2]);
        let digest = super::oci_manifest_digest(&archive).expect("valid slow-reader fixture");
        let deadline = Instant::now() + Duration::from_millis(1);
        let mut slow = SlowReader {
            inner: Cursor::new(archive.clone()),
            delay: Duration::from_millis(5),
        };
        assert!(matches!(
            super::verify_oci_archive_before(&mut slow, Some(&digest), deadline),
            Err(AcquisitionError::Io)
        ));

        let mut slow_names = SlowReader {
            inner: Cursor::new(archive),
            delay: Duration::from_millis(5),
        };
        assert!(matches!(
            super::verify_raw_import_names_before(
                &mut slow_names,
                Instant::now() + Duration::from_millis(1),
            ),
            Err(AcquisitionError::Io)
        ));
    }

    #[test]
    fn authored_dockerfile_cannot_name_the_private_retained_parent_repository() {
        let root = test_root("authored-private-retained-parent");
        let digest = digest(b"retained parent");
        let private_alias = super::retained_parent_alias(&digest).expect("private alias");
        let definition = build_definition(format!(
            "FROM docker.io/openkit/base@{digest} AS base\nCOPY --from={private_alias} /bin/tool /bin/tool\n"
        ));
        assert!(matches!(
            BuildPlan::validate(
                definition,
                &BTreeSet::from(["docker.io".to_string()]),
                Path::new("/run/openkit/nanohost/epoch/docker.sock"),
                &root,
            ),
            Err(AcquisitionError::InvalidBuildDefinition)
        ));
        assert!(!root.exists());
    }

    #[test]
    fn wp3b_build_preflight_accepts_standard_inspect_without_exporter_advertisement() {
        let supported = BuildCapabilities {
            buildkit_version: "0.31.0".into(),
            buildx_version: "0.35.0".into(),
            exec_proxy: true,
        };
        assert_eq!(supported.preflight(), Ok(()));

        for unsupported in [
            BuildCapabilities {
                buildkit_version: "0.30.9".into(),
                ..supported.clone()
            },
            BuildCapabilities {
                buildx_version: "0.34.9".into(),
                ..supported.clone()
            },
            BuildCapabilities {
                exec_proxy: false,
                ..supported.clone()
            },
        ] {
            assert_eq!(
                unsupported.preflight(),
                Err(AcquisitionError::UnsupportedBuildCapability)
            );
        }

        let production = include_str!("image_acquisition.rs")
            .split("#[cfg(test)]")
            .next()
            .expect("image acquisition production section");
        let capability_source = production
            .split_once("pub struct BuildCapabilities")
            .expect("Buildx capability owner")
            .1
            .split_once("/// Direct, fixed Buildx execution plan")
            .expect("end of Buildx capability owner")
            .0;
        assert!(!capability_source.contains("OCI exporter"));
        assert!(!capability_source.contains("oci_exporter"));
        assert_eq!(
            capability_source
                .matches("Command::new(\"/usr/bin/docker\")")
                .count(),
            2,
            "capability proof must remain only Buildx version plus inspect"
        );
        assert!(!capability_source.contains("--dry-run"));
        assert_eq!(capability_source.matches("\"DOCKER_HOST\"").count(), 2);
        assert_eq!(capability_source.matches("\"BUILDX_BUILDER\"").count(), 2);

        let plan_source = production
            .split_once("impl BuildPlan")
            .expect("BuildPlan owner")
            .1
            .split_once("/// Verified OCI-only build output")
            .expect("end of BuildPlan owner")
            .0;
        assert_eq!(plan_source.matches("\"--output\"").count(), 1);
        assert_eq!(plan_source.matches("type=oci,dest=").count(), 1);
    }

    #[test]
    fn wp5_r8_validates_exact_dockerfile_bytes_before_build_plan() {
        let production = include_str!("image_acquisition.rs")
            .split_once("#[cfg(test)]")
            .expect("image acquisition production section")
            .0;
        assert!(
            production.contains("DOCKERFILE_INPUT_MAX_BYTES: usize = 256 * 1024 * 1024"),
            "the independent inline Dockerfile ceiling must have one exact owner"
        );
        let validation = production
            .split_once("fn validate_build_definition(")
            .expect("build-definition validation owner")
            .1
            .split_once("/// Renders the closed strict Buildx policy")
            .expect("end of build-definition validation")
            .0;
        let byte_check = validation
            .find("definition.dockerfile.as_bytes().len()")
            .expect("UTF-8 Dockerfile byte-length check");
        let empty_context = validation
            .find("definition.context_ref != EMPTY_BUILD_CONTEXT_REF")
            .expect("independent empty-context check");
        assert!(empty_context < byte_check);
        assert!(validation[byte_check..].contains("DOCKERFILE_INPUT_MAX_BYTES"));
        assert!(!validation.contains("dockerfile.len()"));
    }

    #[test]
    fn wp5_image_effect_accepts_only_exact_reference_or_build_lineage_and_digest_evidence() {
        assert!(
            ImageEffectRequest::reference(
                "request-local-digest",
                "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            )
            .validate()
            .is_ok()
        );
        let reference = ImageEffectRequest::reference(
            "request-reference",
            "ghcr.io/openkit/worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        );
        assert!(reference.validate().is_ok());
        assert!(
            ImageEffectRequest::reference("request-tag", "ghcr.io/openkit/worker:latest")
                .validate()
                .is_err()
        );
        let build = ImageEffectRequest::build(
            "request-build",
            EMPTY_CONTEXT_DIGEST,
            "sha256:dockerfile",
            "sha256:arguments",
        );
        assert!(build.validate().is_ok());
        assert!(
            ImageEffectRequest::build(
                "request-incomplete",
                "",
                "sha256:dockerfile",
                "sha256:arguments",
            )
            .validate()
            .is_err()
        );
        assert_eq!(
            ImageEffectEvidence::new("request-build", "sha256:result").request_id(),
            "request-build"
        );
        assert!(
            ImageEffectEvidence::new("request-build", "worker:latest")
                .validate()
                .is_err()
        );
        let coordinator = include_str!("epoch_coordinator.rs")
            .split_once("#[cfg(test)]")
            .expect("coordinator production section")
            .0;
        for owner in [
            "RegistryAcquisition::validate",
            "BuildPlan::validate",
            "execute_and_admit",
        ] {
            assert!(
                coordinator.contains(owner),
                "missing image effect owner {owner}"
            );
        }
    }

    #[test]
    fn oci_verifier_streams_a_layer_larger_than_document_buffers() {
        let layer = vec![0x5a; super::OCI_DOCUMENT_MAX_BYTES + 65_537];
        let archive = super::test_oci_archive(&layer);
        assert!(super::oci_manifest_digest(&archive).is_ok());
        let production = include_str!("image_acquisition.rs")
            .split_once("#[cfg(test)]")
            .expect("production source")
            .0;
        assert!(production.contains("ARCHIVE_CHUNK_BYTES: usize = 64 * 1024"));
        assert!(!production.contains("vec![0_u8; size as usize]"));
    }

    #[test]
    fn oci_verifier_rejects_non_regular_required_blobs_and_truncated_skips() {
        let layer = b"required-layer";
        let layer_digest = format!("sha256:{:x}", Sha256::digest(layer));
        let layer_name = format!(
            "blobs/sha256/{}",
            layer_digest.strip_prefix("sha256:").unwrap()
        );
        let mut non_regular = super::test_oci_archive(layer);
        let header = tar_header_offset(&non_regular, &layer_name);
        non_regular[header + 156] = b'5';
        non_regular[header + 148..header + 156].fill(b' ');
        let checksum = non_regular[header..header + 512]
            .iter()
            .map(|byte| u64::from(*byte))
            .sum::<u64>();
        non_regular[header + 148..header + 156]
            .copy_from_slice(format!("{checksum:06o}\0 ").as_bytes());
        assert_eq!(
            super::oci_manifest_digest(&non_regular),
            Err(AcquisitionError::InvalidOciResult)
        );

        let mut truncated = super::test_oci_archive(layer);
        truncated.truncate(truncated.len() - 1024);
        let mut extra = Vec::new();
        super::append_test_tar_member(&mut extra, "unreferenced", b"0123456789");
        truncated.extend_from_slice(&extra[..513]);
        assert!(super::oci_manifest_digest(&truncated).is_err());
    }

    #[test]
    fn registry_manifest_collector_refuses_growth_above_document_bound() {
        let mut manifest = Vec::with_capacity(super::OCI_DOCUMENT_MAX_BYTES);
        super::extend_manifest_bounded(&mut manifest, &vec![0x61; super::OCI_DOCUMENT_MAX_BYTES])
            .expect("exact document ceiling");
        assert_eq!(manifest.len(), super::OCI_DOCUMENT_MAX_BYTES);
        assert_eq!(
            super::extend_manifest_bounded(&mut manifest, b"x"),
            Err(AcquisitionError::InvalidOciResult)
        );
        assert_eq!(manifest.len(), super::OCI_DOCUMENT_MAX_BYTES);
        let production = include_str!("image_acquisition.rs")
            .split_once("#[cfg(test)]")
            .expect("production source")
            .0;
        assert!(!production.contains("pull_manifest_raw"));
        assert!(production.contains("redirect(reqwest::redirect::Policy::none())"));
        assert!(production.contains("Vec::with_capacity(OCI_DOCUMENT_MAX_BYTES)"));
    }

    fn tar_header_offset(archive: &[u8], wanted: &str) -> usize {
        let mut offset = 0_usize;
        while offset + 512 <= archive.len() {
            let header = &archive[offset..offset + 512];
            if header.iter().all(|byte| *byte == 0) {
                break;
            }
            let name_end = header[..100]
                .iter()
                .position(|byte| *byte == 0)
                .unwrap_or(100);
            let name = std::str::from_utf8(&header[..name_end]).unwrap();
            if name == wanted {
                return offset;
            }
            let size_end = header[124..136]
                .iter()
                .position(|byte| *byte == 0)
                .unwrap_or(12);
            let size = u64::from_str_radix(
                std::str::from_utf8(&header[124..124 + size_end])
                    .unwrap()
                    .trim(),
                8,
            )
            .unwrap() as usize;
            offset += 512 + size + (512 - size % 512) % 512;
        }
        panic!("missing tar member {wanted}");
    }
}
