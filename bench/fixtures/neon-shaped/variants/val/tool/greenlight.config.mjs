// Greenlight manifest for this wrapper (fixture form: a plain object, no package import).
export default {
  domain: 'example.test',
  alerts: { sink: 'github-issue' },
  tools: [
    {
      name: 'pollhub',
      lane: 'next',
      target: 'vercel',
      data: 'supabase',
      auth: 'oauth',
      access: 'public',
      envs: ['prod'],
    },
    {
      // A REST service on the free container tier. Its Postgres is Neon, wired directly in
      // infra/ledgerline.tf, so data is "none" here.
      name: 'ledgerline',
      lane: 'mcp',
      target: 'docker',
      data: 'none',
      auth: 'bearer',
      access: 'public',
      envs: ['prod'],
      port: 3000,
      preview: {
        command: 'docker compose -f tools/ledgerline/compose.yaml up -d --build',
        teardown: 'docker compose -f tools/ledgerline/compose.yaml down',
        port: 3000,
        path: '/',
      },
    },
  ],
};
