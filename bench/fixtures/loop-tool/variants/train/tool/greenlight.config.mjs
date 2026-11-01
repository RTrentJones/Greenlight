// Greenlight manifest for this wrapper (fixture form: a plain object, no package import).
export default {
  domain: 'example.test',
  alerts: { sink: 'github-issue' },
  tools: [
    {
      name: 'guestbook',
      lane: 'mcp',
      target: 'docker',
      data: 'none',
      auth: 'none',
      access: 'public',
      envs: ['beta', 'prod'],
      port: 4310,
      preview: { command: 'node tools/guestbook/server.mjs', port: 4310, path: '/' },
    },
    {
      name: 'status-page',
      lane: 'mcp',
      target: 'docker',
      data: 'none',
      auth: 'none',
      access: 'public',
      envs: ['beta', 'prod'],
      port: 4311,
      preview: { command: 'node tools/status-page/server.mjs', port: 4311, path: '/' },
    },
  ],
};
