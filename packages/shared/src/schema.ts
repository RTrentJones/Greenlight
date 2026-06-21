import { z } from 'zod';

/**
 * The Greenlight manifest schema (greenlight-v1.md §4).
 *
 * The schema is the single runtime validator AND the source of exported types.
 * It enforces the V1 lane × target × data matrix at load time, so an illegal
 * combination fails when the config is read — never at deploy.
 */

export const LaneEnum = z.enum(['astro', 'next', 'mcp']);
export const TargetEnum = z.enum(['workers', 'vercel', 'oci']);
export const DataEnum = z.enum(['none', 'd1', 'kv', 'supabase']);
export const AuthEnum = z.enum(['none', 'bearer', 'oauth']);
export const AccessEnum = z.enum(['public', 'private']);
export const EnvEnum = z.enum(['preview', 'beta', 'prod']);

/**
 * V1 lane → allowed targets + allowed data (greenlight-v1.md §4 matrix).
 * `mcp` supports both `workers` (dev/throwaway) and `oci` (BAMCP production).
 */
const MATRIX: Record<
  z.infer<typeof LaneEnum>,
  {
    targets: ReadonlyArray<z.infer<typeof TargetEnum>>;
    data: ReadonlyArray<z.infer<typeof DataEnum>>;
  }
> = {
  astro: { targets: ['workers'], data: ['none', 'd1', 'kv'] },
  next: { targets: ['vercel'], data: ['none', 'supabase'] },
  mcp: { targets: ['workers', 'oci'], data: ['none'] },
};

export const ToolSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/, 'tool name must be kebab-case starting with a letter'),
    lane: LaneEnum,
    target: TargetEnum,
    data: DataEnum,
    auth: AuthEnum.default('none'),
    access: AccessEnum.default('public'),
    envs: z.array(EnvEnum).nonempty('a tool needs at least one env'),
    adopted: z.boolean().default(false),
    // The port the container listens on (target: oci). The tunnel routes to localhost:<port>;
    // defaults to 8000 (the mcp/FastMCP convention). Set it for a lane:docker tool on a different
    // port so the oci modules stay generic. Ignored by non-oci targets.
    port: z.number().int().positive().optional(),
    // Directory the tool builds/deploys from. Defaults to tools/<name>; a standalone
    // (poly-repo) tool sets '.' (the repo root).
    dir: z.string().optional(),
    // The tool's code lives in another repo — this entry is a registry pointer only,
    // not built/deployed here (greenlight-v1.md §15.5 poly-repo).
    external: z.boolean().default(false),
  })
  .superRefine((tool, ctx) => {
    const rule = MATRIX[tool.lane];
    if (!rule.targets.includes(tool.target)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['target'],
        message: `lane "${tool.lane}" does not support target "${tool.target}" (allowed: ${rule.targets.join(', ')})`,
      });
    }
    if (!rule.data.includes(tool.data)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['data'],
        message: `lane "${tool.lane}" does not support data "${tool.data}" (allowed: ${rule.data.join(', ')})`,
      });
    }
    if (tool.access === 'private' && tool.auth === 'none') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['auth'],
        message: 'private tools must set auth to "bearer" or "oauth", never "none"',
      });
    }
  });

/**
 * The blog is special: it lives on Workers and must NEVER use Supabase —
 * Supabase pauses after 7 days idle, and the blog must stay up unattended
 * (greenlight-v1.md §9). The literal types here make that unrepresentable.
 */
export const BlogSchema = z.object({
  lane: z.literal('astro'),
  target: z.literal('workers'),
  data: z.enum(['none', 'd1', 'kv']),
});

export const AlertsSchema = z.object({
  sink: z.enum(['github-issue', 'email']),
});

export const ConfigSchema = z.object({
  domain: z.string().min(1, 'domain is required'),
  alerts: AlertsSchema,
  // Optional: a tool-only repo (a poly-repo consumer) has no blog.
  blog: BlogSchema.optional(),
  tools: z.array(ToolSchema).default([]),
});

/** Resolved config (after defaults applied) — what consumers receive. */
export type GreenlightConfig = z.infer<typeof ConfigSchema>;
/** Authoring shape (before defaults) — what `defineConfig` accepts. */
export type GreenlightConfigInput = z.input<typeof ConfigSchema>;
export type ToolConfig = z.infer<typeof ToolSchema>;
export type BlogConfig = z.infer<typeof BlogSchema>;
export type Lane = z.infer<typeof LaneEnum>;
export type Target = z.infer<typeof TargetEnum>;
export type DataBackend = z.infer<typeof DataEnum>;
export type DeployEnv = z.infer<typeof EnvEnum>;
