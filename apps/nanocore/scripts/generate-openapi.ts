import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAppOpenApiDocument } from '../src/openapi.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifactPath = resolve(packageRoot, 'openapi/app-api.openapi.json');

mkdirSync(dirname(artifactPath), { recursive: true });
writeFileSync(artifactPath, `${JSON.stringify(createAppOpenApiDocument(), null, 2)}\n`);
