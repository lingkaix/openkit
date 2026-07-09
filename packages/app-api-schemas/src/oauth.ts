import { z } from 'zod';

/** Supported OpenAI Codex OAuth login modes. */
export const CodexOAuthLoginModeSchema = z.enum(['browser', 'device_code']);

/** Public OpenAI Codex OAuth status values. */
export const CodexOAuthStatusSchema = z.enum([
  'logged_out',
  'pending',
  'logged_in',
  'unavailable',
  'error',
]);

/** Sanitized OpenAI Codex OAuth status payload. */
export const CodexOAuthStatusPayloadSchema = z
  .object({
    providerId: z.literal('openai_codex'),
    accountSlotId: z.string().min(1),
    displayName: z.string().min(1).optional(),
    isDefault: z.boolean(),
    boundProviderIds: z.array(z.string().min(1)),
    status: CodexOAuthStatusSchema,
    mode: CodexOAuthLoginModeSchema.optional(),
    loginId: z.string().min(1).optional(),
    authUrl: z.string().url().optional(),
    verificationUrl: z.string().url().optional(),
    userCode: z.string().min(1).optional(),
    accountLabel: z.string().min(1).optional(),
    planType: z.string().min(1).optional(),
    message: z.string().min(1).optional(),
  })
  .strict();

/** Sanitized OpenAI Codex OAuth account-slot summary. */
export const CodexOAuthAccountSummarySchema = CodexOAuthStatusPayloadSchema.extend({
  accountSlotId: z.string().min(1),
  boundProviderIds: z.array(z.string().min(1)),
  isDefault: z.boolean(),
});

/** Sanitized OpenAI Codex OAuth account list response. */
export const CodexOAuthAccountsPayloadSchema = z
  .object({
    accounts: z.array(CodexOAuthAccountSummarySchema),
    defaultAccountSlotId: z.string().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    const defaultAccountIndex = value.accounts.findIndex(
      (account) => account.accountSlotId === value.defaultAccountSlotId
    );

    if (defaultAccountIndex === -1) {
      ctx.addIssue({
        code: 'custom',
        message: 'Codex OAuth accounts must include the default account slot.',
        path: ['accounts'],
      });
      return;
    }

    if (!value.accounts[defaultAccountIndex]?.isDefault) {
      ctx.addIssue({
        code: 'custom',
        message: 'Codex OAuth default account must be marked as default.',
        path: ['accounts', defaultAccountIndex, 'isDefault'],
      });
    }
  });

/** Request body for starting a Codex ChatGPT login. */
export const StartOpenAICodexOAuthRequestSchema = z.object({
  mode: CodexOAuthLoginModeSchema.optional(),
});

/** Request body for cancelling a Codex ChatGPT login. */
export const CancelOpenAICodexOAuthRequestSchema = z.object({
  loginId: z.string().min(1).optional(),
});

/** Request body for creating a Codex ChatGPT account slot. */
export const CreateOpenAICodexOAuthAccountRequestSchema = z.object({
  accountSlotId: z.string().min(1),
  displayName: z.string().min(1).optional(),
});

/** Request body for updating a Codex ChatGPT account slot. */
export const UpdateOpenAICodexOAuthAccountRequestSchema = z.object({
  displayName: z.string().min(1),
});

/** Supported OpenAI Codex OAuth login mode. */
export type CodexOAuthLoginMode = z.infer<typeof CodexOAuthLoginModeSchema>;
/** Public OpenAI Codex OAuth status. */
export type CodexOAuthStatus = z.infer<typeof CodexOAuthStatusSchema>;
/** Sanitized OpenAI Codex OAuth status payload. */
export type CodexOAuthStatusPayload = z.infer<typeof CodexOAuthStatusPayloadSchema>;
/** Sanitized OpenAI Codex OAuth account-slot summary. */
export type CodexOAuthAccountSummary = z.infer<typeof CodexOAuthAccountSummarySchema>;
/** Sanitized OpenAI Codex OAuth account list response. */
export type CodexOAuthAccountsPayload = z.infer<typeof CodexOAuthAccountsPayloadSchema>;
/** Request body for starting a Codex ChatGPT login. */
export type StartOpenAICodexOAuthRequest = z.infer<typeof StartOpenAICodexOAuthRequestSchema>;
/** Request body for cancelling a Codex ChatGPT login. */
export type CancelOpenAICodexOAuthRequest = z.infer<typeof CancelOpenAICodexOAuthRequestSchema>;
/** Request body for creating a Codex ChatGPT account slot. */
export type CreateOpenAICodexOAuthAccountRequest = z.infer<
  typeof CreateOpenAICodexOAuthAccountRequestSchema
>;
/** Request body for updating a Codex ChatGPT account slot. */
export type UpdateOpenAICodexOAuthAccountRequest = z.infer<
  typeof UpdateOpenAICodexOAuthAccountRequestSchema
>;
