// Greenlight manifest for this wrapper (fixture form: a plain object, no package import).
export default {
  domain: 'example.test',
  alerts: { sink: 'github-issue' },
  tools: [
    {
      name: 'linkshelf',
      lane: 'mcp',
      target: 'docker',
      data: 'none',
      auth: 'none',
      access: 'public',
      envs: ['beta', 'prod'],
      port: 4321,
      preview: { command: 'node app.mjs', port: 4321, path: '/' },
    },
    {
      name: 'pinboard',
      lane: 'mcp',
      target: 'docker',
      data: 'none',
      auth: 'none',
      access: 'public',
      envs: ['beta', 'prod'],
      port: 4320,
      preview: { command: 'node app.mjs', port: 4320, path: '/pins' },
    },
  ],
};
