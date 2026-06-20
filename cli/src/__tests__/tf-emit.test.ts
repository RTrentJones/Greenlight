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

  it('emits a tunnel + dns (wired) for an mcp/oci tool, no vercel/supabase', () => {
    const tf = emitToolTf({
      name: 'bamcp',
      domain: 'example.dev',
      lane: 'mcp',
      target: 'oci',
      data: 'none',
      envs: ['beta', 'prod'],
    });
    expect(tf).toContain('module "bamcp_tunnel"');
    expect(tf).toContain('module "bamcp_dns"');
    expect(tf).not.toContain('module "bamcp_vercel"');
    expect(tf).not.toContain('module "bamcp_supabase"');
    // dns CNAME points at the tunnel; per-env ingress on the convention ports
    expect(tf).toContain('cname_target = module.bamcp_tunnel.cname_target');
    expect(tf).toContain('hostname = "bamcp.example.dev", service = "http://localhost:8000"');
    expect(tf).toContain('hostname = "beta.bamcp.example.dev", service = "http://localhost:8001"');
    // connector token surfaced (sensitive) for placing on the VM
    expect(tf).toContain('output "bamcp_tunnel_token"');
    expect(tf).toContain('output "bamcp_prod_url"');
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
