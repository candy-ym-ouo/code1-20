import { z } from 'zod';

export const roleSchema = z.enum(['OWNER', 'EDITOR', 'COMMENTER', 'VIEWER']);

const invitationRoleSchema = z.enum(['EDITOR', 'COMMENTER', 'VIEWER']);

const titleSchema = z.string().trim().min(1).max(160);
const summarySchema = z.string().max(4000);
const transcriptSchema = z.string().max(20_000);
const speakerPersonIdSchema = z.string().uuid().nullable();

export const clipSchema = z
  .object({
    title: titleSchema,
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    summary: summarySchema.default(''),
    transcript: transcriptSchema.default(''),
    speakerPersonId: speakerPersonIdSchema.optional(),
    version: z.number().int().positive().optional(),
  })
  .strict()
  .refine((value) => value.endMs > value.startMs, {
    message: 'endMs must be greater than startMs',
    path: ['endMs'],
  });

export const clipUpdateSchema = z
  .object({
    title: titleSchema.optional(),
    startMs: z.number().int().nonnegative().optional(),
    endMs: z.number().int().positive().optional(),
    summary: summarySchema.optional(),
    transcript: transcriptSchema.optional(),
    speakerPersonId: speakerPersonIdSchema.optional(),
    version: z.number().int().positive(),
  })
  .strict();

export const chapterCreateSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    intro: z.string().max(10_000).default(''),
  })
  .strict();

export const chapterUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    intro: z.string().max(10_000).optional(),
    version: z.number().int().positive(),
  })
  .strict();

export const chapterBlockCreateSchema = z
  .object({
    type: z.string().trim().min(1).max(40).default('paragraph'),
    position: z.string().trim().min(1).max(100).optional(),
    content: z.unknown().optional(),
    clipId: z.string().uuid().nullable().optional(),
  })
  .strict();

export const invitationCreateSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    role: invitationRoleSchema,
    // 有效期：1 分钟 ~ 30 天，默认 7 天
    ttlMinutes: z.number().int().min(1).max(30 * 24 * 60).default(7 * 24 * 60),
  })
  .strict();

export const invitationAcceptSchema = z
  .object({
    token: z.string().trim().min(32).max(512),
  })
  .strict();

export type Role = z.infer<typeof roleSchema>;
export type InvitationRole = z.infer<typeof invitationRoleSchema>;
export type ClipInput = z.infer<typeof clipSchema>;
export type ClipUpdateInput = z.infer<typeof clipUpdateSchema>;
export type ChapterCreateInput = z.infer<typeof chapterCreateSchema>;
export type ChapterUpdateInput = z.infer<typeof chapterUpdateSchema>;
export type ChapterBlockCreateInput = z.infer<typeof chapterBlockCreateSchema>;
export type InvitationCreateInput = z.infer<typeof invitationCreateSchema>;
export type InvitationAcceptInput = z.infer<typeof invitationAcceptSchema>;

export const apiError = (code: string, message: string, details?: unknown) => ({
  error: { code, message, details },
  requestId: '',
});
