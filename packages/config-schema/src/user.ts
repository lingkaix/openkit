import { z } from 'zod';

/** Personal preference for one internal Core role in one Workspace. */
export const UserInternalRolePreferenceSchema = z
  .object({
    roleId: z.string().min(1),
    profileId: z.string().min(1).optional(),
    logicalModelId: z.string().min(1).optional(),
  })
  .strict();

/** Personal preferences applied only while the User is in one Workspace. */
export const UserWorkspacePreferenceSchema = z
  .object({
    workspaceId: z.string().min(1),
    agentId: z.string().min(1).optional(),
    profileId: z.string().min(1).optional(),
    logicalModelId: z.string().min(1).optional(),
    internalRoles: z.array(UserInternalRolePreferenceSchema).default([]),
  })
  .strict();

/** Strict User-scoped preference configuration. */
export const UserConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaces: z.array(UserWorkspacePreferenceSchema).default([]),
    extensions: z.record(z.string().min(1), z.unknown()).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const workspaceIds = new Set<string>();
    for (const [index, workspace] of value.workspaces.entries()) {
      if (workspaceIds.has(workspace.workspaceId)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate Workspace preference: ${workspace.workspaceId}.`,
          path: ['workspaces', index, 'workspaceId'],
        });
      }
      workspaceIds.add(workspace.workspaceId);

      const roleIds = new Set<string>();
      for (const [roleIndex, role] of workspace.internalRoles.entries()) {
        if (roleIds.has(role.roleId)) {
          ctx.addIssue({
            code: 'custom',
            message: `Duplicate internal role preference: ${role.roleId}.`,
            path: ['workspaces', index, 'internalRoles', roleIndex, 'roleId'],
          });
        }
        roleIds.add(role.roleId);
      }
    }
  });

/** Authored User preference configuration. */
export type UserConfig = z.infer<typeof UserConfigSchema>;
