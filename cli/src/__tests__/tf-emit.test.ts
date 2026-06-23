import { describe, expect, it } from 'vitest';
import { emitToolTf, emitWrapperMainTf, providersForTool } from '../tf-emit';

describe('emitToolTf', () => {
  it('emits supabase + vercel + dns module blocks for a next/vercel/supabase tool', () => {
    const tf = emitToolTf({
      name: 'heistmind',
      domain: 'example.dev',
      lane: 'next',
      target: 'vercel',
      data: 'supabase',
      envs: ['beta', 'prod'],
      slug: 'acme/demo-app',
      external: true,
    });
    expect(tf).toContain('module "heistmind_supabase"');
    expect(tf).toContain('module "heistmind_vercel"');
    expect(tf).toContain('module "heistmind_dns"');
    // supabase creds flow from the module's outputs (no manual copy)
    expect(tf).toContain('module.heistmind_supabase.url');
    expect(tf).toContain('NEXT_PUBLIC_SUPABASE_URL');
    // external → don't manage GitHub envs in the wrapper
    expect(tf).toContain('manage_github_environments = false');
    // a vercel project id variable is declared
    expect(tf).toContain('variable "heistmind_vercel_project_id"');
    // keepalive nudge (aggregated, not a per-tool worker)
    expect(tf).toContain('module.keepalive.targets_json');
    // pinned module ref
    expect(tf).toMatch(/ref=v\d+\.\d+\.\d+/);
  });

  it('emits the neon module + DATABASE_URL/DIRECT_URL wiring, and NO keepalive, for a next/vercel/neon tool', () => {
    const tf = emitToolTf({
      name: 'notes',
      domain: 'example.dev',
      lane: 'next',
      target: 'vercel',
      data: 'neon',
      envs: ['beta', 'prod'],
    });
    expect(tf).toContain('module "notes_neon"');
    expect(tf).toContain('infra/modules/neon');
    expect(tf).toContain('module "notes_vercel"');
    // pooled (DATABASE_URL) + direct (DIRECT_URL) conn strings flow from the module's per-env outputs
    expect(tf).toContain('DATABASE_URL');
    expect(tf).toContain('DIRECT_URL');
    expect(tf).toContain('module.notes_neon.database_url["prod"]');
    expect(tf).toContain('module.notes_neon.direct_url["beta"]');
    // neon auto-suspends + auto-resumes → NO keepalive (the reason it's the default Postgres)
    expect(tf).not.toContain('module.keepalive.targets_json');
    expect(tf).not.toContain('module "notes_supabase"');
    // no per-tool password var: the connection string is a module OUTPUT, not an input
    expect(tf).not.toContain('notes_neon_database_password');
    // single-account default: no aliased provider
    expect(tf).not.toContain('provider "neon"');
  });

  it('a NEON_API_KEY override emits an aliased neon provider + scoped var + providers={}', () => {
    const tf = emitToolTf({
      name: 'notes',
      domain: 'x.dev',
      lane: 'next',
      target: 'vercel',
      data: 'neon',
      envs: ['prod'],
      tokenOverrides: { NEON_API_KEY: 'NEON_API_KEY_SECONDARY' },
    });
    expect(tf).toContain('providers = { neon = neon.notes }');
    expect(tf).toContain('alias   = "notes"');
    expect(tf).toContain('api_key = var.notes_neon_api_key');
    expect(tf).toContain('variable "notes_neon_api_key"');
    expect(tf).toContain('NEON_API_KEY_SECONDARY');
  });

  it('a dataShareWith tool emits NO neon module but wires the OWNER’s connection strings (one DB, many services)', () => {
    const tf = emitToolTf({
      name: 'worker',
      domain: 'x.dev',
      lane: 'next',
      target: 'vercel',
      data: 'neon',
      envs: ['beta', 'prod'],
      dataShareWith: 'app',
    });
    expect(tf).not.toContain('module "worker_neon"'); // creates nothing
    expect(tf).toContain('module.app_neon.database_url["prod"]'); // reads the owner's branch
    expect(tf).toContain('module.app_neon.direct_url["beta"]');
    expect(tf).toContain('Shares the Neon project owned by "app"');
  });

  it('emits tunnel + container-instance + dns (wired) for an mcp/oci tool', () => {
    const tf = emitToolTf({
      name: 'bamcp',
      domain: 'example.dev',
      lane: 'mcp',
      target: 'oci',
      data: 'none',
      envs: ['beta', 'prod'],
      slug: 'RTrentJones/BAMCP',
    });
    expect(tf).toContain('module "bamcp_tunnel"');
    expect(tf).toContain('module "bamcp_instance"');
    expect(tf).toContain('infra/modules/oci-container-instance');
    expect(tf).toContain('module "bamcp_dns"');
    expect(tf).not.toContain('module "bamcp_vercel"');
    expect(tf).not.toContain('module "bamcp_supabase"');
    // network is IaC: a VCN/subnet module, wired into the instance; no manual subnet/AD vars
    expect(tf).toContain('module "bamcp_network"');
    expect(tf).toContain('infra/modules/oci-network');
    expect(tf).toContain('subnet_id      = module.bamcp_network.subnet_id');
    expect(tf).not.toContain('var.oci_subnet_id');
    expect(tf).not.toContain('var.oci_availability_domain');
    // compartment comes from the shared local (blank → tenancy root), not a per-tool secret
    expect(tf).toContain('compartment_id = local.oci_compartment_id');
    // default container port is 8000 (mcp/FastMCP convention)
    expect(tf).toContain('service = "http://localhost:8000"');
    // tunnel routes prod to the container; dns CNAMEs at the tunnel
    expect(tf).toContain('hostname = "bamcp.example.dev", service = "http://localhost:8000"');
    expect(tf).toContain('cname_target = module.bamcp_tunnel.cname_target');
    // image comes from the tool's own CI (GHCR, lowercased owner); instance gets the tunnel token
    expect(tf).toContain('default     = "ghcr.io/rtrentjones/bamcp:prod"');
    expect(tf).toContain('tunnel_token   = module.bamcp_tunnel.token');
    // outputs: url + token + the instance OCID (for OCI_CONTAINER_INSTANCE_OCID)
    expect(tf).toContain('output "bamcp_tunnel_token"');
    expect(tf).toContain('output "bamcp_container_instance_id"');
    expect(tf).toContain('output "bamcp_prod_url"');
  });

  it('routes the tunnel to a custom container port (lane:docker / non-8000 tools)', () => {
    const tf = emitToolTf({
      name: 'svc',
      domain: 'x.dev',
      lane: 'mcp',
      target: 'oci',
      data: 'none',
      envs: ['prod'],
      port: 3000,
    });
    expect(tf).toContain('service = "http://localhost:3000"');
    expect(tf).not.toContain('localhost:8000');
  });

  it('local (non-external) tool manages GitHub environments', () => {
    const tf = emitToolTf({
      name: 'demo',
      domain: 'x.dev',
      lane: 'astro',
      target: 'workers',
      data: 'none',
      envs: ['beta', 'prod'],
    });
    expect(tf).not.toContain('manage_github_environments = false');
  });

  it('no tokenOverride → default supabase provider (byte-identical, no aliased provider)', () => {
    const tf = emitToolTf({
      name: 'heistmind',
      domain: 'x.dev',
      lane: 'next',
      target: 'vercel',
      data: 'supabase',
      envs: ['prod'],
    });
    expect(tf).not.toContain('provider "supabase"');
    expect(tf).not.toContain('providers = { supabase');
    expect(tf).not.toContain('variable "heistmind_supabase_access_token"');
  });

  it('a SUPABASE_ACCESS_TOKEN override emits an aliased provider + scoped var + providers={}', () => {
    const tf = emitToolTf({
      name: 'heistmind',
      domain: 'x.dev',
      lane: 'next',
      target: 'vercel',
      data: 'supabase',
      envs: ['prod'],
      tokenOverrides: { SUPABASE_ACCESS_TOKEN: 'SUPABASE_ACCESS_TOKEN_HEISTMIND' },
    });
    // the module selects the aliased provider (no module change needed)
    expect(tf).toContain('providers = { supabase = supabase.heistmind }');
    // an aliased provider authenticates with the tool's own token
    expect(tf).toContain('alias        = "heistmind"');
    expect(tf).toContain('access_token = var.heistmind_supabase_access_token');
    expect(tf).toContain('variable "heistmind_supabase_access_token"');
    // the scoped secret name is documented for the infra.yml mapping
    expect(tf).toContain('SUPABASE_ACCESS_TOKEN_HEISTMIND');
  });
});

describe('emitWrapperMainTf', () => {
  it('includes vercel + supabase providers and shared vars when needed', () => {
    const tf = emitWrapperMainTf({
      domain: 'example.dev',
      owner: 'acme',
      providers: ['cloudflare', 'github', 'vercel', 'supabase'],
    });
    expect(tf).toContain('vercel     = { source = "vercel/vercel"');
    expect(tf).toContain('supabase   = { source = "supabase/supabase"');
    expect(tf).toContain('provider "vercel" {}');
    expect(tf).toContain('variable "supabase_organization_id"');
    expect(tf).toContain('provider "github" { owner = "acme" }');
    // HCP backend placeholder, workspace name derived from the domain
    expect(tf).toContain('example-dev');
  });

  it('omits vercel/supabase when only cloudflare+github are needed', () => {
    const tf = emitWrapperMainTf({ domain: 'x.dev', providers: ['cloudflare', 'github'] });
    expect(tf).not.toContain('vercel/vercel');
    expect(tf).not.toContain('supabase/supabase');
  });

  it('includes the neon provider + api_key var when needed', () => {
    const tf = emitWrapperMainTf({
      domain: 'x.dev',
      providers: ['cloudflare', 'github', 'vercel', 'neon'],
    });
    expect(tf).toContain('neon       = { source = "kislerdm/neon"');
    expect(tf).toContain('provider "neon" { api_key = var.neon_api_key }');
    expect(tf).toContain('variable "neon_api_key"');
  });

  it('for oci: auth vars + a compartment local (root default), but no manual subnet/AD vars', () => {
    const tf = emitWrapperMainTf({ domain: 'x.dev', providers: ['cloudflare', 'github', 'oci'] });
    expect(tf).toContain('provider "oci"');
    expect(tf).toContain('variable "oci_tenancy_ocid"');
    expect(tf).toContain('variable "oci_private_key"');
    // compartment is optional (blank → root) and the local resolves it
    expect(tf).toContain('variable "oci_compartment_id"');
    expect(tf).toContain('oci_compartment_id = var.oci_compartment_id != ""');
    // subnet/AD are IaC now — not wrapper vars
    expect(tf).not.toContain('variable "oci_subnet_id"');
    expect(tf).not.toContain('variable "oci_availability_domain"');
  });
});

describe('providersForTool', () => {
  it('maps target/data to the providers main.tf needs', () => {
    expect(providersForTool({ target: 'vercel', data: 'supabase' }).sort()).toEqual([
      'cloudflare',
      'github',
      'supabase',
      'vercel',
    ]);
    expect(providersForTool({ target: 'workers', data: 'none' }).sort()).toEqual([
      'cloudflare',
      'github',
    ]);
    expect(providersForTool({ target: 'vercel', data: 'neon' }).sort()).toEqual([
      'cloudflare',
      'github',
      'neon',
      'vercel',
    ]);
  });
});
