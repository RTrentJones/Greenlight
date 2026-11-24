// Greenlight manifest for the repro wrapper (fixture form: a plain object, no package import).
export default {
  domain: 'example.test',
  alerts: { sink: 'github-issue' },
  tools: [
    {
      // A REST service on a docker host. Its Postgres is Neon, wired directly in
      // infra/ledgerline.tf (so data is "none" here), and Neon scales to zero only while nothing
      // queries it: needs-silence (vision 10 §1.1). No probe may touch the store.
      name: 'ledgerline',
      lane: 'mcp',
      target: 'docker',
      data: 'none',
      auth: 'bearer',
      access: 'public',
      envs: ['prod'],
      port: 3000,
      liveness: { model: 'needs-silence' },
      preview: {
        command: 'docker compose -f tools/ledgerline/compose.yaml up -d --build',
        teardown: 'docker compose -f tools/ledgerline/compose.yaml down',
        port: 3000,
        path: '/',
      },
    },
  ],
};
