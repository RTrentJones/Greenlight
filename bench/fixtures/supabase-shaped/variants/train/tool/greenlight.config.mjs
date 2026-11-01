// Greenlight manifest for this wrapper (fixture form: a plain object, no package import).
export default {
  domain: 'example.test',
  alerts: { sink: 'github-issue' },
  tools: [
    {
      name: 'quizpad',
      lane: 'next',
      target: 'vercel',
      data: 'supabase',
      auth: 'oauth',
      access: 'public',
      envs: ['prod'],
    },
    {
      name: 'mapmaker',
      lane: 'mcp',
      target: 'oci',
      data: 'none',
      auth: 'none',
      access: 'public',
      envs: ['prod'],
      port: 8000,
    },
  ],
};
