/**
 * Terraform emitters — the "CLI edits declarative IaC" core. `greenlight add`/`adopt`
 * call these to write `infra/<name>.tf` (the per-tool module blocks) and, for a fresh
 * wrapper, `infra/main.tf` (the singleton: providers + backend + shared vars). Nothing
 * here applies — CI/CD (the wrapper's infra.yml, HCP-backed) does. Pure + tested.
 *
 * Generalizes the live, hand-tuned `heistmind.tf` + `adopt.ts::infraTf()` so adding a tool
 * is one manifest entry + one emitted `.tf` the user reviews and commits.
 */

import { packsForTool } from './providers';
import { MODULE_REF, moduleSource } from './version';

export interface ToolTfOpts {
  name: string;
  domain: string;
  lane: string;
  target: string;
  data: string;
  envs: string[];
  /** owner/repo for the DNS module's github_repo. */
  slug?: string;
  /** External tool (code/CI in its own repo) → don't manage its GitHub environments here. */
  external?: boolean;
  ref?: string;
}

const hcl = (s: string) => s.replace(/\n{3,}/g, '\n\n').trimEnd();

/** The per-tool `infra/<name>.tf` — module blocks for the providers this tool uses.
 * Assumes the wrapper's `infra/main.tf` provides the providers + shared variables (the
 * header lists which); never re-declares providers/backend (those are wrapper singletons). */
export function emitToolTf(opts: ToolTfOpts): string {
  const { name, domain, lane, target, data, envs, ref = MODULE_REF } = opts;
  const slug = opts.slug ?? `OWNER/${name}`;
  const useSupabase = data === 'supabase';
  const useVercel = target === 'vercel';
  const envList = envs.map((e) => `"${e}"`).join(', ');
  const blocks: string[] = [];

  const assumes = ['var.cloudflare_zone_id'];
  if (useSupabase) assumes.push('var.supabase_organization_id', 'var.supabase_database_password');

  blocks.push(
    `# ${name} — ${lane}/${target}${useSupabase ? '/supabase' : ''}, emitted by \`greenlight add\`.
# Review, then commit + push: the wrapper's infra.yml (HCP-backed) runs \`terraform apply\`.
# Assumes infra/main.tf declares: ${[useVercel && 'vercel', useSupabase && 'supabase'].filter(Boolean).join(' + ') || 'cloudflare + github'} provider(s)
# and the variables ${assumes.join(', ')}.${
      opts.external
        ? `\n# External tool: app code + deploy live in ${slug}; this manages only its infra here.`
        : ''
    }`,
  );

  if (useSupabase) {
    blocks.push(`# One Supabase project (schema-per-env), kept declarative + recreatable + kept alive.
module "${name}_supabase" {
  source = "${moduleSource('supabase', ref)}"

  name              = "${name}"
  project_name      = "${name}-db"
  organization_id   = var.supabase_organization_id
  database_password = var.supabase_database_password
  region            = "us-east-1"
}`);
  }

  if (useVercel) {
    const env = useSupabase
      ? `
  environment = {
    site_url_prod     = { key = "SITE_URL", target = ["production"], sensitive = false }
    site_url_beta     = { key = "SITE_URL", target = ["preview"], sensitive = false }
    supa_url_prod     = { key = "NEXT_PUBLIC_SUPABASE_URL", target = ["production"], sensitive = false }
    supa_anon_prod    = { key = "NEXT_PUBLIC_SUPABASE_ANON_KEY", target = ["production"], sensitive = false }
    supa_service_prod = { key = "SUPABASE_SERVICE_ROLE_KEY", target = ["production"], sensitive = true }
    supa_url_beta     = { key = "NEXT_PUBLIC_SUPABASE_URL", target = ["preview"], sensitive = false }
    supa_anon_beta    = { key = "NEXT_PUBLIC_SUPABASE_ANON_KEY", target = ["preview"], sensitive = false }
    supa_service_beta = { key = "SUPABASE_SERVICE_ROLE_KEY", target = ["preview"], sensitive = true }
  }
  environment_values = {
    site_url_prod     = "https://${name}.${domain}"
    site_url_beta     = "https://beta.${name}.${domain}"
    supa_url_prod     = module.${name}_supabase.url
    supa_anon_prod    = module.${name}_supabase.anon_key
    supa_service_prod = module.${name}_supabase.service_role_key
    supa_url_beta     = module.${name}_supabase.url
    supa_anon_beta    = module.${name}_supabase.anon_key
    supa_service_beta = module.${name}_supabase.service_role_key
  }`
      : `
  # No managed data store — add environment/environment_values if the app needs vars.
  environment        = {}
  environment_values = {}`;
    blocks.push(`# Configure the EXISTING Vercel project (domains + env vars). Deploys ride git integration.
module "${name}_vercel" {
  source = "${moduleSource('vercel', ref)}"

  project_id  = var.${name}_vercel_project_id
  name        = "${name}"
  domain      = "${domain}"
  beta_branch = "develop"
${env}
}

variable "${name}_vercel_project_id" {
  type        = string
  description = "Vercel project id for ${name} (prj_…); the project must already exist."
}`);
  }

  blocks.push(`# Subdomain DNS — CNAME ${name}/beta.${name} → ${useVercel ? 'cname.vercel-dns.com' : 'the target'}.
module "${name}_dns" {
  source = "${moduleSource('tool', ref)}"

  name        = "${name}"
  domain      = "${domain}"
  zone_id     = var.cloudflare_zone_id
  github_repo = "${slug}"
  lane        = "${lane}"
  target      = "${target}"
  data        = "${data}"
  envs        = [${envList}]${
    opts.external
      ? '\n  # External repo managed elsewhere; no GitHub envs here so CI stays single-repo.\n  manage_github_environments = false'
      : ''
  }
}`);

  if (useSupabase) {
    blocks.push(`# Keepalive: add this tool to the aggregated keepalive worker so its Supabase DB
# never idle-pauses. In infra/keepalive.tf, append to module.keepalive.targets_json:
#   { name = "${name}", env = "prod", url = module.${name}_supabase.url, anonKey = module.${name}_supabase.anon_key }`);
  }

  blocks.push(
    useVercel
      ? `output "${name}_prod_url" { value = module.${name}_vercel.prod_url }
output "${name}_beta_url" { value = module.${name}_vercel.beta_url }`
      : `output "${name}_prod_url" { value = module.${name}_dns.prod_url }`,
  );

  return `${hcl(blocks.join('\n\n'))}\n`;
}

/** The singleton `infra/main.tf` for a fresh wrapper — providers + backend placeholder +
 * shared variables. Only written when absent; never overwrites a live, tuned main.tf. */
export function emitWrapperMainTf(opts: {
  domain: string;
  owner?: string;
  providers: string[];
}): string {
  const owner = opts.owner ?? 'OWNER';
  const need = new Set(opts.providers);
  const req: string[] = [
    '    cloudflare = { source = "cloudflare/cloudflare", version = "~> 5.0" }',
    '    github     = { source = "integrations/github", version = "~> 6.0" }',
  ];
  if (need.has('vercel'))
    req.push('    vercel     = { source = "vercel/vercel", version = "~> 3.0" }');
  if (need.has('supabase'))
    req.push('    supabase   = { source = "supabase/supabase", version = "~> 1.0" }');

  const providerBlocks = ['provider "cloudflare" {}', `provider "github" { owner = "${owner}" }`];
  if (need.has('vercel')) providerBlocks.push('provider "vercel" {}');
  if (need.has('supabase')) providerBlocks.push('provider "supabase" {}');

  const vars = ['variable "cloudflare_zone_id" { type = string }'];
  vars.push('variable "cloudflare_account_id" {\n  type    = string\n  default = ""\n}');
  if (need.has('supabase')) {
    vars.push('variable "supabase_organization_id" { type = string }');
    vars.push(
      'variable "supabase_database_password" {\n  type      = string\n  sensitive = true\n  default   = "import-placeholder" # ignored when importing an existing project\n}',
    );
  }

  return `# Wrapper infra (singleton): providers + remote-state backend + shared variables.
# \`greenlight add\` appends per-tool module blocks as infra/<name>.tf. Apply is CI/CD's job
# (infra.yml). Fill in the HCP backend below before the first apply (docs/terraform-state-r2.md).

terraform {
  required_version = ">= 1.7"
  required_providers {
${req.join('\n')}
  }

  # Remote state — HCP Terraform free tier (no credit card). Uncomment + set org/workspace:
  # cloud {
  #   organization = "YOUR_ORG"
  #   workspaces { name = "${opts.domain.replace(/\./g, '-')}" }
  # }
}

${providerBlocks.join('\n')}

${vars.join('\n')}
`;
}

/** Which `required_providers`/provider blocks a tool needs in main.tf (cloudflare/github
 * always; vercel/supabase per target/data). Used to scaffold or to nudge the user. */
export function providersForTool(tool: { target?: string; data?: string }): string[] {
  const ids = new Set(packsForTool(tool).map((p) => p.id));
  const out = ['cloudflare', 'github'];
  if (ids.has('vercel')) out.push('vercel');
  if (ids.has('supabase')) out.push('supabase');
  return out;
}
