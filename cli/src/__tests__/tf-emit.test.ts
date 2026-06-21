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
  });
});
