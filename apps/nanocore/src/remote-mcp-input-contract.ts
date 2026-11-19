// Keep this field projection in parity with the administrator CLI's compactInputContract.
const VALUE_KEYS = [
  'type',
  'enum',
  'const',
  'description',
  'format',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
] as const;
const ALTERNATIVES = ['anyOf', 'oneOf', 'allOf'] as const;
type Schema = Readonly<Record<string, unknown>>;

/** Keeps flat alternatives and scalar constraints without expanding nested values. */
export function compactInputContract(schema: Schema): Record<string, unknown> {
  const contract = compactValueContract(schema);
  if (schema.properties) {
    contract.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([name, property]) => [
        name,
        compactValueContract(property),
      ])
    );
  }
  if (schema.required) contract.required = schema.required;
  if (Object.hasOwn(schema, 'additionalProperties')) {
    contract.additionalProperties = schema.additionalProperties;
  }
  for (const key of ALTERNATIVES) {
    const alternatives = schema[key];
    if (Array.isArray(alternatives)) contract[key] = alternatives.map(compactInputContract);
  }
  return contract;
}

function compactValueContract(schema: Schema): Record<string, unknown> {
  const contract: Record<string, unknown> = {};
  for (const key of VALUE_KEYS) {
    if (Object.hasOwn(schema, key)) contract[key] = schema[key];
  }
  for (const key of ALTERNATIVES) {
    const alternatives = schema[key];
    if (Array.isArray(alternatives)) contract[key] = alternatives.map(compactValueContract);
  }
  return contract;
}
