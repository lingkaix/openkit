import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'jsonc-parser';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const snapshotVersion = '2026-07-11';
const snapshotRoot = join(packageRoot, 'snapshots', snapshotVersion);

/**
 * Reads and parses a JSON file that must contain an object.
 *
 * @param {string} path File path to read.
 * @returns {Record<string, unknown>} Parsed JSON object.
 * @throws {Error} When the file is not a JSON object.
 */
function readJsonObject(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Expected JSON object in ${path}`);
  }

  return parsed;
}

/**
 * Reads and parses a JSONC file that must contain an object.
 *
 * @param {string} path File path to read.
 * @returns {Record<string, unknown>} Parsed JSONC object.
 * @throws {Error} When the file is not a JSONC object.
 */
function readJsoncObject(path) {
  const parsed = parse(readFileSync(path, 'utf8'));

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Expected JSONC object in ${path}`);
  }

  return parsed;
}

/**
 * Calculates the SHA-256 checksum for a local file.
 *
 * @param {string} path File path to hash.
 * @returns {string} Hex-encoded SHA-256 digest.
 */
function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Returns the models map for a models.dev provider record.
 *
 * @param {unknown} provider Provider value from the models.dev snapshot.
 * @param {string} providerId Provider id used for error messages.
 * @returns {Record<string, unknown>} Provider models keyed by model id.
 * @throws {Error} When the provider or models map is malformed.
 */
function readModelsDevModels(provider, providerId) {
  if (typeof provider !== 'object' || provider === null || Array.isArray(provider)) {
    throw new Error(`Expected models.dev provider object for ${providerId}`);
  }

  const models = provider.models;

  if (typeof models !== 'object' || models === null || Array.isArray(models)) {
    throw new Error(`Expected models map for models.dev provider ${providerId}`);
  }

  return models;
}

/**
 * Validates the current models.dev snapshot and NanoCore template mappings.
 *
 * @returns {Promise<void>}
 * @throws {Error} When metadata, checksums, snapshot data, or template mappings are invalid.
 */
async function validateSnapshot() {
  const apiPath = join(snapshotRoot, 'api.json');
  const metadata = readJsonObject(join(snapshotRoot, 'metadata.json'));
  const api = readJsonObject(apiPath);

  if (metadata.checksumSha256 !== sha256File(apiPath)) {
    throw new Error('metadata.checksumSha256 does not match snapshots api.json');
  }

  if (metadata.sourceUrl !== 'https://models.dev/api.json') {
    throw new Error('metadata.sourceUrl must point to the models.dev API');
  }

  if (metadata.version !== snapshotVersion || metadata.refreshedAt !== snapshotVersion) {
    throw new Error('metadata version and refreshedAt must match the current snapshot version');
  }

  for (const key of [
    'fetchedAt',
    'responseEtag',
    'rawChecksumSha256',
    'observedSourceRevision',
    'observedSourceRevisionAt',
  ]) {
    if (typeof metadata[key] !== 'string' || metadata[key].length === 0) {
      throw new Error(`metadata.${key} must be a non-empty string`);
    }
  }

  const providerMappings = metadata.providerMappings;

  if (
    typeof providerMappings !== 'object' ||
    providerMappings === null ||
    Array.isArray(providerMappings)
  ) {
    throw new Error('metadata.providerMappings must be a JSON object');
  }

  for (const [mappingId, mappingValue] of Object.entries(providerMappings)) {
    if (typeof mappingValue !== 'object' || mappingValue === null || Array.isArray(mappingValue)) {
      throw new Error(`Expected provider mapping object for ${mappingId}`);
    }

    const templateFile = mappingValue.templateFile;
    const templateProviderId = mappingValue.templateProviderId;
    const modelsDevProviderId = mappingValue.modelsDevProviderId;

    if (typeof templateFile !== 'string' || typeof templateProviderId !== 'string') {
      throw new Error(`Provider mapping ${mappingId} must declare template file and provider id`);
    }

    const template = readJsoncObject(join(repoRoot, templateFile));

    if (template.id !== templateProviderId) {
      throw new Error(`Template ${templateFile} id does not match metadata mapping`);
    }

    if (modelsDevProviderId === null) {
      continue;
    }

    if (typeof modelsDevProviderId !== 'string') {
      throw new Error(`Provider mapping ${mappingId} modelsDevProviderId must be a string or null`);
    }

    const provider = api[modelsDevProviderId];
    const models = readModelsDevModels(provider, modelsDevProviderId);

    for (const model of template.models ?? []) {
      if (typeof model !== 'string' || !Object.hasOwn(models, model)) {
        throw new Error(`Template ${templateFile} model ${model} is not present in models.dev`);
      }
    }
  }

  await validatePiAiReconciliation(api, metadata);
}

/**
 * Validates the metadata-controlled pi-ai reconciliation scope.
 *
 * @param {Record<string, unknown>} modelsDevApi Parsed models.dev snapshot.
 * @param {Record<string, unknown>} metadata Parsed snapshot metadata.
 * @returns {Promise<void>}
 */
async function validatePiAiReconciliation(modelsDevApi, metadata) {
  const reconciliation = metadata.piAiReconciliation;

  if (
    typeof reconciliation !== 'object' ||
    reconciliation === null ||
    Array.isArray(reconciliation)
  ) {
    throw new Error('metadata.piAiReconciliation must be a JSON object');
  }

  const expectedVersion = reconciliation.piAiVersion;
  const tolerance = reconciliation.priceToleranceRatio;
  const providers = reconciliation.providers;
  const acceptedPriceDifferences = readAcceptedPriceDifferences(
    reconciliation.acceptedPriceDifferences
  );

  if (typeof expectedVersion !== 'string') {
    throw new Error('metadata.piAiReconciliation.piAiVersion must be a string');
  }
  if (typeof tolerance !== 'number' || tolerance < 0) {
    throw new Error(
      'metadata.piAiReconciliation.priceToleranceRatio must be a non-negative number'
    );
  }
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new Error('metadata.piAiReconciliation.providers must be a non-empty array');
  }

  const piAiRoot = realpathSync(join(repoRoot, 'apps/nanocore/node_modules/@earendil-works/pi-ai'));
  const piAiPackage = readJsonObject(join(piAiRoot, 'package.json'));

  if (piAiPackage.version !== expectedVersion) {
    throw new Error(`Expected pi-ai ${expectedVersion}, found ${piAiPackage.version}`);
  }

  const piAiModelsModule = await import(
    pathToFileURL(join(piAiRoot, 'dist/models.generated.js')).href
  );
  const piAiProviders = piAiModelsModule.MODELS;

  if (typeof piAiProviders !== 'object' || piAiProviders === null || Array.isArray(piAiProviders)) {
    throw new Error('Expected pi-ai generated models object');
  }

  for (const entry of providers) {
    validatePiAiProvider(modelsDevApi, piAiProviders, entry, tolerance, acceptedPriceDifferences);
  }
  if (acceptedPriceDifferences.size > 0) {
    throw new Error('pi-ai reconciliation contains an unused accepted price difference');
  }
}

/**
 * Reads the exact release-bound price differences accepted during dependency review.
 *
 * @param {unknown} value Metadata candidate.
 * @returns {Map<string, {modelsDev: number, piAi: number}>} Unconsumed exact differences.
 */
function readAcceptedPriceDifferences(value) {
  if (!Array.isArray(value)) {
    throw new Error('metadata.piAiReconciliation.acceptedPriceDifferences must be an array');
  }
  const accepted = new Map();
  for (const entry of value) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      Array.isArray(entry) ||
      Object.keys(entry).sort().join(',') !==
        'field,modelId,modelsDev,modelsDevProviderId,piAi,piAiProviderId' ||
      !['input', 'output', 'cacheRead', 'cacheWrite'].includes(entry.field) ||
      typeof entry.modelId !== 'string' ||
      typeof entry.modelsDevProviderId !== 'string' ||
      typeof entry.piAiProviderId !== 'string' ||
      typeof entry.modelsDev !== 'number' ||
      typeof entry.piAi !== 'number'
    ) {
      throw new Error('Invalid pi-ai accepted price difference');
    }
    const key = [entry.modelsDevProviderId, entry.piAiProviderId, entry.modelId, entry.field].join(
      '\0'
    );
    if (accepted.has(key)) {
      throw new Error('Duplicate pi-ai accepted price difference');
    }
    accepted.set(key, { modelsDev: entry.modelsDev, piAi: entry.piAi });
  }
  return accepted;
}

/**
 * Validates one provider mapping between models.dev and pi-ai model catalogs.
 *
 * @param {Record<string, unknown>} modelsDevApi Parsed models.dev snapshot.
 * @param {Record<string, unknown>} piAiProviders pi-ai generated provider model maps.
 * @param {unknown} entry Provider reconciliation metadata.
 * @param {number} tolerance Relative price tolerance.
 * @param {Map<string, {modelsDev: number, piAi: number}>} acceptedPriceDifferences Exact reviewed differences.
 */
function validatePiAiProvider(
  modelsDevApi,
  piAiProviders,
  entry,
  tolerance,
  acceptedPriceDifferences
) {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new Error('Expected pi-ai reconciliation provider object');
  }

  const modelsDevProviderId = entry.modelsDevProviderId;
  const piAiProviderId = entry.piAiProviderId;
  const modelIds = entry.modelIds;

  if (typeof modelsDevProviderId !== 'string' || typeof piAiProviderId !== 'string') {
    throw new Error('pi-ai reconciliation provider ids must be strings');
  }
  if (modelIds !== undefined && (!Array.isArray(modelIds) || modelIds.length === 0)) {
    throw new Error('pi-ai reconciliation modelIds must be a non-empty array when set');
  }

  const modelsDevModels = readModelsDevModels(
    modelsDevApi[modelsDevProviderId],
    modelsDevProviderId
  );
  const piAiModels = piAiProviders[piAiProviderId];

  if (typeof piAiModels !== 'object' || piAiModels === null || Array.isArray(piAiModels)) {
    throw new Error(`Expected pi-ai provider models for ${piAiProviderId}`);
  }

  if (modelIds) {
    for (const modelId of modelIds) {
      if (typeof modelId !== 'string') {
        throw new Error('pi-ai reconciliation modelIds entries must be strings');
      }
      if (!Object.hasOwn(modelsDevModels, modelId)) {
        throw new Error(`models.dev ${modelsDevProviderId} is missing reconciled model ${modelId}`);
      }
      if (!Object.hasOwn(piAiModels, modelId)) {
        throw new Error(`pi-ai ${piAiProviderId} is missing reconciled model ${modelId}`);
      }
      validatePiAiModelCost(
        modelsDevProviderId,
        modelId,
        modelsDevModels[modelId],
        piAiModels[modelId],
        tolerance,
        piAiProviderId,
        acceptedPriceDifferences
      );
    }

    return;
  }

  let commonModelCount = 0;

  for (const [modelId, piAiModel] of Object.entries(piAiModels)) {
    if (!Object.hasOwn(modelsDevModels, modelId)) {
      continue;
    }

    commonModelCount += 1;
    validatePiAiModelCost(
      modelsDevProviderId,
      modelId,
      modelsDevModels[modelId],
      piAiModel,
      tolerance,
      piAiProviderId,
      acceptedPriceDifferences
    );
  }

  if (commonModelCount === 0) {
    throw new Error(
      `No common models found for models.dev ${modelsDevProviderId} and pi-ai ${piAiProviderId}`
    );
  }
}

/**
 * Validates matching model pricing fields.
 *
 * @param {string} providerId Provider id used for errors.
 * @param {string} modelId Model id used for errors.
 * @param {unknown} modelsDevModel models.dev model record.
 * @param {unknown} piAiModel pi-ai model record.
 * @param {number} tolerance Relative price tolerance.
 * @param {string} piAiProviderId pi-ai provider id used in the exact difference identity.
 * @param {Map<string, {modelsDev: number, piAi: number}>} acceptedPriceDifferences Exact reviewed differences.
 */
function validatePiAiModelCost(
  providerId,
  modelId,
  modelsDevModel,
  piAiModel,
  tolerance,
  piAiProviderId,
  acceptedPriceDifferences
) {
  const modelsDevCost = readCost(modelsDevModel, `models.dev ${providerId}/${modelId}`);
  const piAiCost = readCost(piAiModel, `pi-ai ${providerId}/${modelId}`);
  const fields = [
    ['input', 'input'],
    ['output', 'output'],
    ['cacheRead', 'cache_read'],
    ['cacheWrite', 'cache_write'],
  ];

  for (const [piAiField, modelsDevField] of fields) {
    if (piAiCost[piAiField] === undefined || modelsDevCost[modelsDevField] === undefined) {
      continue;
    }

    const expected = modelsDevCost[modelsDevField];
    const actual = piAiCost[piAiField];
    const relativeDifference = Math.abs(actual - expected) / Math.max(Math.abs(expected), 1e-12);

    if (relativeDifference > tolerance) {
      const key = [providerId, piAiProviderId, modelId, piAiField].join('\0');
      const accepted = acceptedPriceDifferences.get(key);
      if (accepted?.modelsDev === expected && accepted.piAi === actual) {
        acceptedPriceDifferences.delete(key);
        continue;
      }
      throw new Error(
        `pi-ai ${providerId}/${modelId} ${piAiField} price ${actual} differs from models.dev ${expected}`
      );
    }
  }
}

/**
 * Reads a model cost object.
 *
 * @param {unknown} model Model record.
 * @param {string} label Label used for errors.
 * @returns {Record<string, number | undefined>} Cost object.
 */
function readCost(model, label) {
  if (typeof model !== 'object' || model === null || Array.isArray(model)) {
    throw new Error(`Expected model object for ${label}`);
  }

  const cost = model.cost;

  if (typeof cost !== 'object' || cost === null || Array.isArray(cost)) {
    throw new Error(`Expected cost object for ${label}`);
  }

  return cost;
}

await validateSnapshot();
