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
  /** Web page to create THIS token, if different from the pack's `setupUrl` (e.g. a PAT page). */
  setupUrl?: string;
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
  /** Web console where these tokens are created — printed by `greenlight secrets gather`. */
  setupUrl?: string;
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
    setupUrl: 'https://dash.cloudflare.com/profile/api-tokens',
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
    setupUrl: 'https://vercel.com/account/settings/tokens',
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
    setupUrl: 'https://supabase.com/dashboard/account/tokens',
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
    setupUrl: 'https://app.terraform.io/app/settings/tokens',
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
    setupUrl: 'https://github.com/settings/personal-access-tokens/new',
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
    guide: 'docs/oci-payg-runbook.md — Always-Free A1 Container Instance + tunnel (no PAYG)',
    setupUrl: 'https://cloud.oracle.com — Profile → User settings → Tokens and keys → Add API key',
    tokens: [
      // OCI provider auth = API-key request signing (no bearer → no cheap fetch verify). These
      // flow to the `oci` Terraform provider as TF_VAR_oci_* (the wrapper apply uses them).
      { envVar: 'TF_VAR_oci_tenancy_ocid', label: 'OCI tenancy OCID', optional: true },
      { envVar: 'TF_VAR_oci_user_ocid', label: 'OCI user OCID', optional: true },
      { envVar: 'TF_VAR_oci_fingerprint', label: 'OCI API key fingerprint', optional: true },
      {
        envVar: 'TF_VAR_oci_private_key',
        label: 'OCI API private key (PEM content)',
        optional: true,
      },
      { envVar: 'TF_VAR_oci_region', label: 'OCI region, e.g. us-ashburn-1', optional: true },
      // Container Instance placement (your Always-Free compartment / AD / a public subnet).
      { envVar: 'TF_VAR_oci_compartment_id', label: 'OCI compartment OCID', optional: true },
      {
        envVar: 'TF_VAR_oci_availability_domain',
        label: 'OCI availability domain',
        optional: true,
      },
      {
        envVar: 'TF_VAR_oci_subnet_id',
        label: 'OCI subnet OCID (public, for egress)',
        optional: true,
      },
      // Deploy (restart the instance → re-pull). Set from the Terraform output.
      {
        envVar: 'OCI_CONTAINER_INSTANCE_OCID',
        label: 'container instance OCID (TF output) — `greenlight deploy` restarts it',
        optional: true,
      },
      // Option-B event-driven deploy (GitHub PATs). dispatch → set on the TOOL repo;
      // status → set on the WRAPPER repo. Skip the one that doesn't match `--repo`.
      {
        envVar: 'GREENLIGHT_DISPATCH_TOKEN',
        label: 'GitHub PAT, Contents:write on the WRAPPER (TOOL repo fires the deploy dispatch)',
        optional: true,
        setupUrl: 'https://github.com/settings/personal-access-tokens/new',
      },
      {
        envVar: 'GREENLIGHT_STATUS_TOKEN',
        label: 'GitHub PAT, Commits:write on the TOOL (WRAPPER posts deploy status back)',
        optional: true,
        setupUrl: 'https://github.com/settings/personal-access-tokens/new',
      },
    ],
    skill: 'provider-oci',
    tfModules: ['tool', 'tunnel', 'oci-container-instance'], // DNS + tunnel + compute; deploy = restart
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
