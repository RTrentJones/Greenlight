// Greenlight manifest for this wrapper (fixture form: a plain object, no package import).
export default {
  domain: 'example.test',
  alerts: { sink: 'github-issue' },
  tools: [
    {
      // Postgres is Neon, wired directly in infra (infra/scenesmith.tf), so data is "none" here.
      name: 'scenesmith',
      lane: 'mcp',
      target: 'oci',
      data: 'none',
      auth: 'none',
      access: 'public',
      envs: ['prod'],
      port: 8080,
      preview: {
        command: 'docker compose -f tools/scenesmith/compose.yaml up -d --build',
        teardown: 'docker compose -f tools/scenesmith/compose.yaml down',
        port: 8080,
        path: '/mcp',
      },
    },
    {
      name: 'quizdesk',
      lane: 'next',
      target: 'vercel',
      data: 'supabase',
      auth: 'oauth',
      access: 'public',
      envs: ['prod'],
    },
  ],
};
