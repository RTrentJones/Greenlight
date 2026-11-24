// Greenlight manifest for this wrapper (fixture form: a plain object, no package import).
export default {
  domain: 'example.test',
  alerts: { sink: 'github-issue' },
  tools: [
    {
      name: 'relaydesk',
      lane: 'mcp',
      target: 'oci',
      data: 'none',
      auth: 'bearer',
      access: 'public',
      envs: ['prod'],
      port: 8000,
    },
    {
      name: 'tripnote',
      lane: 'next',
      target: 'vercel',
      data: 'supabase',
      auth: 'oauth',
      access: 'public',
      envs: ['prod'],
    },
  ],
};
