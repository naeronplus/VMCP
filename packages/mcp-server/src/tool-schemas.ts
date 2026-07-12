/**
 * Zod input schemas for Vibrato MCP tools (M-14: create_job shape tests).
 */
import { z } from 'zod';

/** list_jobs */
export const listJobsInputSchema = {
  projectId: z.string().uuid().optional(),
} as const;

/** get_job / get_job_status */
export const jobIdInputSchema = {
  jobId: z.string().uuid(),
} as const;

/**
 * create_job — enqueue generation.
 * Required: projectId (UUID). Optional: commitStrategy, godotVersion, preferredTier.
 */
export const createJobInputSchema = {
  projectId: z.string().uuid(),
  commitStrategy: z.enum(['same-machine', 'cross-machine']).optional(),
  godotVersion: z.string().optional(),
  preferredTier: z.enum(['A', 'B']).optional(),
} as const;

/** Zod object form for parse tests (same fields as createJobInputSchema). */
export const createJobInputObjectSchema = z.object(createJobInputSchema);

/** Canonical tool names — must stay in sync with createVibratoMcpServer registration. */
export const VIBRATO_TOOL_NAMES = [
  'list_projects',
  'list_jobs',
  'get_job',
  'create_job',
  'list_locks',
  'get_job_status',
] as const;

export type VibratoToolName = (typeof VIBRATO_TOOL_NAMES)[number];

export const VIBRATO_TOOL_COUNT = VIBRATO_TOOL_NAMES.length;
