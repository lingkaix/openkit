import { z } from 'zod';
import {
  AutomationRecordSchema,
  CreateAutomationRequestSchema,
  ListAutomationsResponseSchema,
  UpdateAutomationRequestSchema,
} from './automation.js';

const credentials = [
  'local-user',
  'user-session',
  'user-bearer',
  'deployment-administrator',
] as const;
const child = {
  credentials,
  scope: { kind: 'opaque-child-workspace', childField: 'automationId' },
  target: { kind: 'automation' },
  policyOperation: 'workspace.write',
  mutating: true,
} as const;
/** Definition-derived public projection of the existing user-private automation store. */
export const AUTOMATION_OPERATION_DEFINITIONS = {
  'automation.list': {
    description: 'List automation definitions in authorized Workspaces.',
    inputSchema: z.object({}).strict(),
    outputSchema: ListAutomationsResponseSchema,
    credentials,
    scope: { kind: 'authorized-workspace-set' },
    target: { kind: 'authorized-workspaces' },
    policyOperation: 'workspace.read',
    mutating: false,
  },
  'automation.create': {
    description: 'Create one paused automation definition.',
    inputSchema: CreateAutomationRequestSchema.strict(),
    outputSchema: AutomationRecordSchema,
    credentials,
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'workspace' },
    policyOperation: 'workspace.write',
    mutating: true,
    successStatus: 201,
  },
  'automation.update': {
    ...child,
    description: 'Update one automation definition.',
    inputSchema: UpdateAutomationRequestSchema.extend({ automationId: z.string().min(1) }).strict(),
    outputSchema: AutomationRecordSchema,
  },
  'automation.delete': {
    ...child,
    description: 'Delete one automation definition.',
    inputSchema: z.object({ automationId: z.string().min(1) }).strict(),
    outputSchema: z.null(),
    successStatus: 204,
  },
} as const;
