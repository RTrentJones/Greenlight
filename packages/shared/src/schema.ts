import { z } from 'zod';

/**
 * The Greenlight manifest schema (docs/archive/greenlight-v1.md §4).
 *
 * The schema is the single runtime validator AND the source of exported types.
 * It enforces the V1 lane × target × data matrix at load time, so an illegal
 * combination fails when the config is read — never at deploy.
 */

export const LaneEnum = z.enum(['astro', 'next', 'mcp', 'agent']);
export const TargetEnum = z.enum(['workers', 'vercel', 'oci', 'docker']);
export const DataEnum = z.enum(['none', 'd1', 'kv', 'supabase', 'neon']);
export const AuthEnum = z.enum(['none', 'bearer', 'oauth']);
export const AccessEnum = z.enum(['public', 'private']);
export const EnvEnum = z.enum(['preview', 'beta', 'prod']);

/**
 * V1 lane → allowed targets + allowed data (docs/archive/greenlight-v1.md §4 matrix).
 * `mcp` supports `workers` (dev/throwaway), `oci` (BAMCP production), and `docker` (a self-hosted
 * SSH box / homelab — same container image as oci, a host you own instead of the free tier).
 * `agent` is an autonomous cron-triggered Worker (LLM-backed, Gemini free tier); `kv` holds its
 * last output + run metadata (see docs/agents-plan.md).
 */
export const MATRIX: Record<
  z.infer<typeof LaneEnum>,
  {
    targets: ReadonlyArray<z.infer<typeof TargetEnum>>;
    data: ReadonlyArray<z.infer<typeof DataEnum>>;
  }
> = {
  astro: { targets: ['workers'], data: ['none', 'd1', 'kv'] },
  next: { targets: ['vercel'], data: ['none', 'supabase', 'neon'] },
  mcp: { targets: ['workers', 'oci', 'docker'], data: ['none'] },
  agent: { targets: ['workers'], data: ['none', 'kv'] },
};

/** The lane × target × data matrix as a human-readable table — for `greenlight lanes` and `add`'s
 * error, so valid combinations are discoverable at the point of use (not just on a schema reject). */
export function describeMatrix(): string {
  return (Object.keys(MATRIX) as Array<keyof typeof MATRIX>)
    .map((lane) => {
      const r = MATRIX[lane];
      return `  ${lane.padEnd(6)} → target: ${r.targets.join(' | ')}   data: ${r.data.join(' | ')}`;
    })
    .join('\n');
}

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
    // The port the container listens on (target: oci | docker). The Cloudflare tunnel routes to
    // localhost:<port>; defaults to 8000 (the mcp/FastMCP convention). Set it for a container tool
    // on a different port so the tunnel/modules stay generic. Ignored by non-container targets.
    port: z.number().int().positive().optional(),
    // Directory the tool builds/deploys from. Defaults to tools/<name>; a standalone
    // (poly-repo) tool sets '.' (the repo root).
    dir: z.string().optional(),
    // The tool's code lives in another repo — this entry is a registry pointer only,
    // not built/deployed here (docs/archive/greenlight-v1.md §15.5 poly-repo).
    external: z.boolean().default(false),
    // How `greenlight preview` spins the tool up LOCALLY for the pre-deploy gate. Optional — node
    // lanes (astro/next/mcp→workers) use the built-in build+serve path. Set it for targets with no
    // built-in serve (e.g. oci/docker: a docker command that matches the prod transport). The harness polls
    // the local URL (http://localhost:<port><path>), verifies, then runs `teardown`.
    preview: z
      .object({
        command: z.string(), // spin up locally in the background (e.g. a `docker compose … up`)
        teardown: z.string().optional(), // tear down afterwards (e.g. `docker compose … down`)
        port: z.number().int().positive().optional(), // local port (default: tool.port ?? lane default)
        path: z.string().optional(), // connect path (default: lane default, e.g. `/mcp`)
      })
      .optional(),
    // The project-scoped secret names this tool needs (e.g. ['TF_VAR_HEISTMIND_GITHUB_ADMIN_TOKEN']).
    // The convention (docs/tokens-reference.md): a project-scoped secret carries the uppercased tool name.
    // `doctor` warns on a name that doesn't — documentation + conformance, no behavior.
    tokens: z.array(z.string()).optional(),
    // Opt-in per-tool provider-token OVERRIDES (multi-account). Maps a provider's default token env
    // var to an alternate secret name, so this tool authenticates that provider with a SECOND account
    // — e.g. { SUPABASE_ACCESS_TOKEN: 'SUPABASE_ACCESS_TOKEN_HEISTMIND' }. Absent ⇒ unchanged (the
    // default token). `add`/`adopt` emit an aliased provider + scoped var/secret for an overridden token.
    tokenOverrides: z.record(z.string(), z.string()).optional(),
    // Share another tool's data store instead of creating one (multiple services on one Neon DB).
    // The value is the OWNER tool's name; this tool emits no data module and wires the owner's
    // connection strings. Cross-tool validity (owner exists, same data, no chains) is checked on
    // the whole config below.
    dataShareWith: z.string().optional(),
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
    if (tool.dataShareWith && tool.data !== 'neon') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dataShareWith'],
        message: 'dataShareWith currently supports data: "neon" only',
      });
    }
  });

/**
 * The blog is special: it lives on Workers and must NEVER use Supabase —
 * Supabase pauses after 7 days idle, and the blog must stay up unattended
 * (docs/archive/greenlight-v1.md §9). The literal types here make that unrepresentable.
 */
export const BlogSchema = z.object({
  lane: z.literal('astro'),
  target: z.literal('workers'),
  data: z.enum(['none', 'd1', 'kv']),
});

export const AlertsSchema = z.object({
  sink: z.enum(['github-issue', 'email']),
});

/** A DNS hostname: dot-separated alphanumeric/hyphen labels + an alphabetic TLD. Validating this at
 * load time means a malformed domain (quotes, spaces, shell/HCL metacharacters) is rejected here
 * rather than producing broken/injectable output when it's interpolated into emitted Terraform,
 * `curl`, `jq`, or workflow YAML downstream. */
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

export const ConfigSchema = z
  .object({
    domain: z
      .string()
      .min(1, 'domain is required')
      .regex(DOMAIN_RE, 'domain must be a valid hostname, e.g. "example.com"'),
    alerts: AlertsSchema,
    // Optional: a tool-only repo (a poly-repo consumer) has no blog.
    blog: BlogSchema.optional(),
    tools: z.array(ToolSchema).default([]),
  })
  .superRefine((config, ctx) => {
    // Shared data store (multiple services on one Neon DB): a tool's `dataShareWith` must name another
    // tool that OWNS a matching store — same `data`, not itself, and not itself a sharer (no chains).
    for (const [i, tool] of config.tools.entries()) {
      if (!tool.dataShareWith) continue;
      const issue = (message: string) =>
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tools', i, 'dataShareWith'], message });
      if (tool.dataShareWith === tool.name) {
        issue(`"${tool.name}" cannot share a data store with itself`);
        continue;
      }
      const owner = config.tools.find((t) => t.name === tool.dataShareWith);
      if (!owner) {
        issue(`dataShareWith "${tool.dataShareWith}" is not a tool in this manifest`);
        continue;
      }
      if (owner.data !== tool.data) {
        issue(
          `"${tool.name}" (data: ${tool.data}) must share a tool with the same data — "${owner.name}" is ${owner.data}`,
        );
      }
      if (owner.dataShareWith) {
        issue(
          `cannot share with "${owner.name}" — it is itself a sharer (no chains); point at the owner`,
        );
      }
      if (tool.tokenOverrides?.NEON_API_KEY) {
        issue(
          `a sharer uses the owner's Neon account — remove the NEON_API_KEY override from "${tool.name}"`,
        );
      }
    }
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
