/**
 * The provider-pack registry — one declaration per infra provider of everything onboarding
 * it needs: the tokens (+ scopes + a fail-fast verify), the deep guide, its MCP server(s),
 * its agent skill, and the Terraform module(s) its block references. This formalizes what
 * used to be scattered across `init.ts` (token flags), `agent-kit.ts` (MCP by target/data),
 * `docs/provider-tokens.md` (prose), and `infra/modules/*`. The CLI (`init`/`add`/`adopt`)
 * drives onboarding from here. Adding a new free-tier backend = write one `ProviderPack`.
 *
 * Model: the CLI EDITS declarative IaC + gathers/validates tokens + wires the kit; CI/CD
 * deploys. Nothing here applies/deploys.
 */

/** An MCP server entry in a repo's `.mcp.json` (defined here so the registry owns the MCP
 * declarations; re-exported from `agent-kit` for the kit/merge plumbing). */
export interface McpServer {
  type: string;
  url: string;
  /** Optional headers (e.g. a Bearer token via ${ENV} interpolation). */
  headers?: Record<string, string>;
}

/** A tool's provider-relevant facets (a subset of the manifest entry). */
export interface ProviderToolInfo {
  target?: string;
  data?: string;
}

export interface TokenCheck {
  ok: boolean;
  detail?: string;
}

export interface TokenSpec {
  /** Provider-store env var, e.g. CLOUDFLARE_API_TOKEN. */
  envVar: string;
  /** Human label shown during setup. */
  label: string;
  /** Least-privilege scopes to request when creating the token. */
  scopes?: string[];
  /** Not strictly required up front (e.g. a project ref you don't have yet). */
  optional?: boolean;
  /** Fail-fast check: given the token value (+ the other gathered tokens), confirm it
   * authenticates / has scope. Network call; omitted for providers without a cheap check. */
  verify?: (token: string, env: Record<string, string>) => Promise<TokenCheck>;
}

export interface ProviderPack {
  id: string;
  name: string;
  /** Always applies, regardless of the tool (e.g. Cloudflare is the zone/DNS for every tool). */
  always?: boolean;
  /** Whether this provider applies to a given tool, by target/data. */
  appliesTo(tool: ProviderToolInfo): boolean;
  /** Tokens this provider needs in the provider stores. */
  tokens: TokenSpec[];
  /** Pointer into the deep guide (docs/provider-tokens.md / terraform-state-r2.md). */
  guide: string;
  /** MCP server(s) to add to a repo's `.mcp.json` (consumed by the agent kit). */
  mcp?: Record<string, McpServer>;
  /** Per-provider skill dir under plugin/skills (`provider-<id>`). */
  skill?: string;
  /** Terraform module(s) under infra/modules/* that this provider's block references. */
  tfModules?: string[];
}

const okStatus = (r: Response) => r.ok;

export const PACKS: ProviderPack[] = [
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    always: true, // the zone/DNS provider + Workers (keepalive) for every Greenlight setup
    appliesTo: () => true,
    guide: 'docs/provider-tokens.md — CLOUDFLARE_API_TOKEN (Workers Scripts:Edit + Zone DNS:Edit)',
    tokens: [
      {
        envVar: 'CLOUDFLARE_API_TOKEN',
        label: 'API token — Workers Scripts:Edit + Zone DNS:Edit',
        scopes: [
          'Account · Workers Scripts · Edit',
          'Zone · DNS · Edit',
          'Account · Account Settings · Read',
        ],
        verify: async (t) => {
          const r = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
            headers: { Authorization: `Bearer ${t}` },
          });
          const j = (await r.json().catch(() => ({}))) as { result?: { status?: string } };
          return { ok: r.ok && j.result?.status === 'active', detail: j.result?.status };
        },
      },
    ],
    mcp: {
      cloudflare: { type: 'http', url: 'https://mcp.cloudflare.com/mcp' },
      'cloudflare-docs': { type: 'http', url: 'https://docs.mcp.cloudflare.com/mcp' },
    },
    skill: 'provider-cloudflare',
    tfModules: ['tool', 'keepalive'],
  },
  {
    id: 'vercel',
    name: 'Vercel',
    appliesTo: (t) => t.target === 'vercel',
    guide: 'docs/provider-tokens.md — VERCEL_API_TOKEN (team-scoped)',
    tokens: [
      {
        envVar: 'VERCEL_API_TOKEN',
        label: 'API token (scope to your team)',
        verify: async (t) => {
          const r = await fetch('https://api.vercel.com/v2/user', {
            headers: { Authorization: `Bearer ${t}` },
          });
          return { ok: okStatus(r), detail: `HTTP ${r.status}` };
        },
      },
    ],
    mcp: { vercel: { type: 'http', url: 'https://mcp.vercel.com' } },
    skill: 'provider-vercel',
    tfModules: ['vercel'],
  },
  {
    id: 'supabase',
    name: 'Supabase',
    appliesTo: (t) => t.data === 'supabase',
    guide: 'docs/provider-tokens.md — SUPABASE_ACCESS_TOKEN (Management API)',
    tokens: [
      {
        envVar: 'SUPABASE_ACCESS_TOKEN',
        label: 'Management API access token',
        verify: async (t) => {
          const r = await fetch('https://api.supabase.com/v1/projects', {
            headers: { Authorization: `Bearer ${t}` },
          });
          return { ok: okStatus(r), detail: `HTTP ${r.status}` };
        },
      },
      {
        envVar: 'TF_VAR_supabase_database_password',
        label: 'database password (ignored when importing an existing project)',
        optional: true,
      },
    ],
    mcp: {
      supabase: {
        type: 'http',
        url: 'https://mcp.supabase.com/mcp?project_ref=${SUPABASE_PROJECT_REF}&read_only=true',
        headers: { Authorization: 'Bearer ${SUPABASE_ACCESS_TOKEN}' },
      },
    },
    skill: 'provider-supabase',
    tfModules: ['supabase'],
  },
  {
    id: 'hcp',
    name: 'HCP Terraform (remote state)',
    always: true, // remote state backs every wrapper's infra
    appliesTo: () => true,
    guide: 'docs/terraform-state-r2.md — HCP Terraform free tier (no credit card)',
    tokens: [
      {
        envVar: 'TF_API_TOKEN',
        label: 'HCP Terraform user API token (state backend auth)',
        verify: async (t) => {
          const r = await fetch('https://app.terraform.io/api/v2/organizations', {
            headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/vnd.api+json' },
          });
          return { ok: okStatus(r), detail: `HTTP ${r.status}` };
        },
      },
    ],
    skill: 'provider-hcp',
  },
  {
    id: 'github',
    name: 'GitHub',
    always: true, // secrets sync + repo/branch infra
    appliesTo: () => true,
    guide: 'docs/provider-tokens.md — GitHub (gh auth, or a fine-grained PAT)',
    tokens: [
      {
        envVar: 'GITHUB_TOKEN',
        label: 'GitHub token (gh-provided in CI; PAT for cross-repo)',
        optional: true, // usually provided by `gh` / the Actions built-in token
      },
    ],
    skill: 'provider-github',
    tfModules: ['repo'],
  },
  {
    id: 'oci',
    name: 'Oracle Cloud (OCI)',
    appliesTo: (t) => t.target === 'oci',
    guide: 'docs/oci-payg-runbook.md — OCI Always-Free → PAYG (avoid idle reclaim)',
    tokens: [
      // OCI uses request-signing (API key), not a bearer token — no cheap fetch verify;
      // setup is a manual runbook. Presence-only here.
      { envVar: 'OCI_CLI_CONFIG', label: 'OCI CLI config / API key (see runbook)', optional: true },
    ],
    skill: 'provider-oci',
    tfModules: ['tool'], // DNS/Tunnel; the oci deploy adapter is separate (out of scope)
  },
];

/** The provider packs a tool needs: always-on packs + those whose `appliesTo` matches. */
export function packsForTool(tool?: ProviderToolInfo): ProviderPack[] {
  return PACKS.filter((p) => p.always || (tool ? p.appliesTo(tool) : false));
}

/** MCP servers for a tool — merged from its applicable packs (Cloudflare always, etc.). */
export function mcpForTool(tool?: ProviderToolInfo): Record<string, McpServer> {
  const out: Record<string, McpServer> = {};
  for (const pack of packsForTool(tool)) {
    if (pack.mcp) Object.assign(out, pack.mcp);
  }
  return out;
}

/** Distinct token specs a tool's providers require (dedup by envVar). */
export function tokensForTool(tool?: ProviderToolInfo): TokenSpec[] {
  const seen = new Set<string>();
  const out: TokenSpec[] = [];
  for (const pack of packsForTool(tool)) {
    for (const tok of pack.tokens) {
      if (!seen.has(tok.envVar)) {
        seen.add(tok.envVar);
        out.push(tok);
      }
    }
  }
  return out;
}

/** Terraform modules a tool's providers reference (dedup, for the `infra/<name>.tf` emit). */
export function tfModulesForTool(tool?: ProviderToolInfo): string[] {
  const out = new Set<string>();
  for (const pack of packsForTool(tool)) {
    for (const m of pack.tfModules ?? []) out.add(m);
  }
  return [...out];
}
