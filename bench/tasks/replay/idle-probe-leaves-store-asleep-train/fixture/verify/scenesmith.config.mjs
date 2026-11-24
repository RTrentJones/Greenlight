// Deploy gate for scenesmith: the MCP surface answers, and the app reaches its database.
export default [
  { id: 'scenesmith-mcp', mode: 'mcp', expectTools: ['generate_scene'] },
  {
    id: 'scenesmith-ready',
    mode: 'api',
    checks: [
      {
        id: 'database-reachable',
        path: '/health',
        status: 200,
        json: [{ path: 'database', equals: 'up' }],
      },
    ],
  },
];

export const meta = { invariant: ['scenesmith-mcp', 'database-reachable'] };
