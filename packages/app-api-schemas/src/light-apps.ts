import { ActorRefSchema, RequestIdSchema, TimestampSchema } from '@openkit/protocol';
import { z } from 'zod';

/** User-authored Light App collection and field names. */
export const LightAppNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,62}$/, 'Name must match [a-z][a-z0-9_]{0,62}.');

/** Reserved record metadata names that callers cannot declare as fields. */
export const LIGHT_APP_RESERVED_FIELD_NAMES = ['id', 'created', 'updated', 'revision'] as const;

/** Initial Kernel scalar field types. */
export const LightAppFieldTypeSchema = z.enum([
  'text',
  'number',
  'bool',
  'date',
  'select',
  'relation',
]);

/** JSON object that forbids unknown keys after schema validation. */
const unknownRecordSchema = z.record(z.string(), z.unknown());

/** Text field options. */
export const LightAppTextFieldOptionsSchema = z
  .object({
    max: z.number().int().min(1).max(4096).optional(),
  })
  .strict();

/** Number field options. */
export const LightAppNumberFieldOptionsSchema = z
  .object({
    onlyInt: z.boolean().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .strict();

/** Select field options. */
export const LightAppSelectFieldOptionsSchema = z
  .object({
    values: z.array(z.string().min(1)).min(1).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.values).size !== value.values.length) {
      context.addIssue({
        code: 'custom',
        message: 'Select values must be distinct.',
        path: ['values'],
      });
    }
  });

/** Relation field options. Collection selectors resolve to stable IDs on admission. */
export const LightAppRelationFieldOptionsSchema = z
  .object({
    collection: z.string().min(1),
  })
  .strict();

/** One authored Light App field. */
export const LightAppFieldInputSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: LightAppNameSchema,
    type: LightAppFieldTypeSchema,
    required: z.boolean(),
    description: z.string(),
    unit: z.string().min(1).optional(),
    namespace: z.string().min(1).optional(),
    options: unknownRecordSchema.optional(),
  })
  .strict()
  .superRefine((field, context) => {
    if ((LIGHT_APP_RESERVED_FIELD_NAMES as readonly string[]).includes(field.name)) {
      context.addIssue({
        code: 'custom',
        message: `Field name ${field.name} is reserved.`,
        path: ['name'],
      });
    }
    switch (field.type) {
      case 'text': {
        const parsed = LightAppTextFieldOptionsSchema.safeParse(field.options ?? {});
        if (!parsed.success) {
          context.addIssue({
            code: 'custom',
            message: 'Invalid text field options.',
            path: ['options'],
          });
        }
        break;
      }
      case 'number': {
        const parsed = LightAppNumberFieldOptionsSchema.safeParse(field.options ?? {});
        if (!parsed.success) {
          context.addIssue({
            code: 'custom',
            message: 'Invalid number field options.',
            path: ['options'],
          });
        }
        break;
      }
      case 'bool':
      case 'date':
        if (field.options !== undefined) {
          context.addIssue({
            code: 'custom',
            message: `${field.type} fields do not accept options.`,
            path: ['options'],
          });
        }
        break;
      case 'select': {
        const parsed = LightAppSelectFieldOptionsSchema.safeParse(field.options);
        if (!parsed.success) {
          context.addIssue({
            code: 'custom',
            message: 'Select fields require distinct nonempty values.',
            path: ['options'],
          });
        }
        break;
      }
      case 'relation': {
        const parsed = LightAppRelationFieldOptionsSchema.safeParse(field.options);
        if (!parsed.success) {
          context.addIssue({
            code: 'custom',
            message: 'Relation fields require a collection selector.',
            path: ['options'],
          });
        }
        break;
      }
      default:
        break;
    }
  });

/** One authored index over current names or stable field IDs. */
export const LightAppIndexInputSchema = z
  .object({
    fields: z.array(z.string().min(1)).min(1).max(4),
    unique: z.boolean(),
  })
  .strict();

/** One authored base collection. */
export const LightAppCollectionInputSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: LightAppNameSchema,
    type: z.literal('base'),
    description: z.string(),
    fields: z.array(LightAppFieldInputSchema).min(1).max(64),
    indexes: z.array(LightAppIndexInputSchema).max(8),
  })
  .strict()
  .superRefine((collection, context) => {
    const names = collection.fields.map((field) => field.name);
    if (new Set(names).size !== names.length) {
      context.addIssue({
        code: 'custom',
        message: 'Collection field names must be unique.',
        path: ['fields'],
      });
    }
    const ids = collection.fields
      .map((field) => field.id)
      .filter((id): id is string => Boolean(id));
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: 'custom',
        message: 'Collection field IDs must be unique.',
        path: ['fields'],
      });
    }
  });

/** File-authored Light App schema proposal. */
export const LightAppSchemaInputSchema = z
  .object({
    format: z.literal('openkit.light-app'),
    schemaVersion: z.literal(1),
    title: z.string().min(1),
    purpose: z.string(),
    collections: z.array(LightAppCollectionInputSchema).min(1).max(16),
  })
  .strict()
  .superRefine((schema, context) => {
    const names = schema.collections.map((collection) => collection.name);
    if (new Set(names).size !== names.length) {
      context.addIssue({
        code: 'custom',
        message: 'Collection names must be unique.',
        path: ['collections'],
      });
    }
    const ids = schema.collections
      .map((collection) => collection.id)
      .filter((id): id is string => Boolean(id));
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: 'custom',
        message: 'Collection IDs must be unique.',
        path: ['collections'],
      });
    }
  });

/** Admitted field with Core-assigned identity and resolved relation targets. */
export const LightAppAdmittedFieldSchema = z
  .object({
    id: z.string().uuid(),
    name: LightAppNameSchema,
    type: LightAppFieldTypeSchema,
    required: z.boolean(),
    description: z.string(),
    unit: z.string().min(1).optional(),
    namespace: z.string().min(1).optional(),
    options: unknownRecordSchema.optional(),
  })
  .strict();

/** Admitted collection with Core-assigned identity. */
export const LightAppAdmittedCollectionSchema = z
  .object({
    id: z.string().uuid(),
    name: LightAppNameSchema,
    type: z.literal('base'),
    description: z.string(),
    fields: z.array(LightAppAdmittedFieldSchema).min(1).max(64),
    indexes: z.array(
      z
        .object({
          fields: z.array(z.string().uuid()).min(1).max(4),
          unique: z.boolean(),
        })
        .strict()
    ),
  })
  .strict();

/** Immutable admitted schema document retained as definition bytes. */
export const LightAppAdmittedSchemaSchema = z
  .object({
    format: z.literal('openkit.light-app'),
    schemaVersion: z.literal(1),
    appId: z.string().uuid(),
    schemaRevision: z.number().int().positive(),
    title: z.string().min(1),
    purpose: z.string(),
    collections: z.array(LightAppAdmittedCollectionSchema).min(1).max(16),
  })
  .strict();

/** Discoverable Kernel type, operator, and limit vocabulary. */
export const LightAppCapabilitiesSchema = z
  .object({
    fieldTypes: z.array(LightAppFieldTypeSchema),
    filterOperators: z.array(z.enum(['=', '!=', '>', '>=', '<', '<=', '&&', '||'])),
    maxPerPage: z.literal(100),
    maxRecords: z.literal(10_000),
    maxBatchEntries: z.literal(50),
    maxFilterBytes: z.literal(2048),
  })
  .strict();

/** Catalog lifecycle projected from app authority. */
export const LightAppLifecycleSchema = z.enum(['active', 'retired', 'unavailable']);

/** One Light App catalog row. */
export const LightAppCatalogItemSchema = z
  .object({
    appId: z.string().uuid(),
    title: z.string().min(1),
    purpose: z.string(),
    appRevision: z.number().int().positive(),
    schemaRevision: z.number().int().positive(),
    schemaDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    lifecycle: LightAppLifecycleSchema,
  })
  .strict();

/** Paged Light App catalog. */
export const ListLightAppsResponseSchema = z
  .object({
    page: z.number().int().positive(),
    perPage: z.number().int().positive().max(100),
    totalItems: z.number().int().nonnegative(),
    totalPages: z.number().int().nonnegative(),
    items: z.array(LightAppCatalogItemSchema),
  })
  .strict();

/** App get result with admitted schema and capabilities. */
export const GetLightAppResponseSchema = LightAppCatalogItemSchema.extend({
  schema: LightAppAdmittedSchemaSchema.nullable(),
  capabilities: LightAppCapabilitiesSchema,
}).strict();

/** Create-app body is the schema proposal. */
export const CreateLightAppRequestSchema = LightAppSchemaInputSchema;

/** Create-app result. */
export const CreateLightAppResponseSchema = GetLightAppResponseSchema;

/** Schema update body. */
export const UpdateLightAppSchemaRequestSchema = z
  .object({
    expectedAppRevision: z.number().int().positive(),
    expectedSchemaRevision: z.number().int().positive(),
    schema: LightAppSchemaInputSchema,
  })
  .strict();

/** Schema update result. */
export const UpdateLightAppSchemaResponseSchema = GetLightAppResponseSchema;

/** Retire-app body. */
export const RetireLightAppRequestSchema = z
  .object({
    expectedAppRevision: z.number().int().positive(),
  })
  .strict();

/** Retire-app result. */
export const RetireLightAppResponseSchema = GetLightAppResponseSchema;

/** Canonical RFC3339 millisecond UTC timestamp used by date fields. */
export const LightAppDateValueSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

/** JSON value admitted for one Kernel field. */
export const LightAppFieldValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/** Public Kernel record wire shape. */
export const LightAppRecordSchema = z
  .object({
    id: z.string().uuid(),
    collectionId: z.string().uuid(),
    collectionName: LightAppNameSchema,
    revision: z.number().int().positive(),
    schemaRevision: z.number().int().positive(),
    created: TimestampSchema,
    updated: TimestampSchema,
    data: z.record(z.string(), LightAppFieldValueSchema),
  })
  .strict();

/** Record list result. */
export const ListLightAppRecordsResponseSchema = z
  .object({
    page: z.number().int().positive(),
    perPage: z.number().int().positive().max(100),
    totalItems: z.number().int().nonnegative(),
    totalPages: z.number().int().nonnegative(),
    schemaRevision: z.number().int().positive(),
    completeResult: z.boolean(),
    items: z.array(LightAppRecordSchema),
  })
  .strict();

/** Single-record get result. */
export const GetLightAppRecordResponseSchema = LightAppRecordSchema;

/** Create-record body. */
export const CreateLightAppRecordRequestSchema = z
  .object({
    schemaRevision: z.number().int().positive(),
    data: z.record(z.string(), LightAppFieldValueSchema),
  })
  .strict();

/** Create-record result. */
export const CreateLightAppRecordResponseSchema = LightAppRecordSchema;

/** Update-record body. */
export const UpdateLightAppRecordRequestSchema = z
  .object({
    schemaRevision: z.number().int().positive(),
    expectedRecordRevision: z.number().int().positive(),
    data: z.record(z.string(), LightAppFieldValueSchema),
  })
  .strict();

/** Update-record result. */
export const UpdateLightAppRecordResponseSchema = LightAppRecordSchema;

/** One virtual PocketBase-style batch entry. */
export const LightAppBatchRequestEntrySchema = z
  .object({
    method: z.enum(['POST', 'PATCH']),
    url: z.string().min(1),
    body: z.unknown(),
  })
  .strict();

/** Bounded atomic batch body. */
export const LightAppBatchRequestSchema = z
  .object({
    schemaRevision: z.number().int().positive(),
    requests: z.array(LightAppBatchRequestEntrySchema).min(1).max(50),
  })
  .strict();

/** Batch result: current app metadata plus ordered current records. */
export const LightAppBatchResponseSchema = z
  .object({
    app: LightAppCatalogItemSchema,
    items: z.array(LightAppRecordSchema),
  })
  .strict();

/** Actor lineage retained with Kernel mutations; not part of the public record wire shape. */
export const LightAppMutationActorSchema = ActorRefSchema;

/** Request identity required by Kernel mutation headers. */
export const LightAppRequestIdSchema = RequestIdSchema;

/** File-authored Light App schema proposal. */
export type LightAppSchemaInput = z.infer<typeof LightAppSchemaInputSchema>;
/** Immutable admitted schema document. */
export type LightAppAdmittedSchema = z.infer<typeof LightAppAdmittedSchemaSchema>;
/** One admitted collection. */
export type LightAppAdmittedCollection = z.infer<typeof LightAppAdmittedCollectionSchema>;
/** One admitted field. */
export type LightAppAdmittedField = z.infer<typeof LightAppAdmittedFieldSchema>;
/** One Light App catalog row. */
export type LightAppCatalogItem = z.infer<typeof LightAppCatalogItemSchema>;
/** Public Kernel record wire shape. */
export type LightAppRecord = z.infer<typeof LightAppRecordSchema>;
/** Create-app body. */
export type CreateLightAppRequest = z.infer<typeof CreateLightAppRequestSchema>;
/** Create-app result. */
export type CreateLightAppResponse = z.infer<typeof CreateLightAppResponseSchema>;
/** App get result. */
export type GetLightAppResponse = z.infer<typeof GetLightAppResponseSchema>;
/** Catalog list result. */
export type ListLightAppsResponse = z.infer<typeof ListLightAppsResponseSchema>;
/** Schema update body. */
export type UpdateLightAppSchemaRequest = z.infer<typeof UpdateLightAppSchemaRequestSchema>;
/** Schema update result. */
export type UpdateLightAppSchemaResponse = z.infer<typeof UpdateLightAppSchemaResponseSchema>;
/** Retire-app body. */
export type RetireLightAppRequest = z.infer<typeof RetireLightAppRequestSchema>;
/** Retire-app result. */
export type RetireLightAppResponse = z.infer<typeof RetireLightAppResponseSchema>;
/** Record list result. */
export type ListLightAppRecordsResponse = z.infer<typeof ListLightAppRecordsResponseSchema>;
/** Record get result. */
export type GetLightAppRecordResponse = z.infer<typeof GetLightAppRecordResponseSchema>;
/** Create-record body. */
export type CreateLightAppRecordRequest = z.infer<typeof CreateLightAppRecordRequestSchema>;
/** Update-record body. */
export type UpdateLightAppRecordRequest = z.infer<typeof UpdateLightAppRecordRequestSchema>;
/** Update-record result. */
export type UpdateLightAppRecordResponse = z.infer<typeof UpdateLightAppRecordResponseSchema>;
/** Batch body. */
export type LightAppBatchRequest = z.infer<typeof LightAppBatchRequestSchema>;
/** Batch result. */
export type LightAppBatchResponse = z.infer<typeof LightAppBatchResponseSchema>;
