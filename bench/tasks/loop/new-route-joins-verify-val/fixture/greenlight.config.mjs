// Greenlight manifest for this wrapper (fixture form: a plain object, no package import).
export default {
  domain: 'example.test',
  alerts: { sink: 'github-issue' },
  tools: [
    {
      name: 'potluck',
      lane: 'mcp',
      target: 'docker',
      data: 'none',
      auth: 'none',
      access: 'public',
      envs: ['beta', 'prod'],
      port: 4341,
      preview: { command: 'node app.mjs', port: 4341, path: '/' },
    },
    {
      name: 'trailnotes',
      lane: 'mcp',
      target: 'docker',
      data: 'none',
      auth: 'none',
      access: 'public',
      envs: ['beta', 'prod'],
      port: 4340,
      preview: { command: 'node app.mjs', port: 4340, path: '/' },
    },
  ],
};
