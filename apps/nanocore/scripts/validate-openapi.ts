import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { validateAppOpenApiDocument } from '../src/openapi-validation.js';

const artifactPath = resolve('openapi/app-api.openapi.json');
const schemaPath = resolve('openapi/oas-3.1-schema-2022-10-07.json');
const errors = await validateAppOpenApiDocument(
  JSON.parse(readFileSync(artifactPath, 'utf8')),
  JSON.parse(readFileSync(schemaPath, 'utf8'))
);

if (errors.length > 0) {
  for (const error of errors) {
    console.error(error);
  }
  process.exit(1);
}
