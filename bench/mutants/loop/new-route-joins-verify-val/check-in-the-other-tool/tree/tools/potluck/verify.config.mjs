// Deploy gate for potluck.
export default {
  id: 'potluck-gate',
  mode: 'api',
  checks: [
    { id: 'dishes-list', path: '/', status: 200, json: [{ path: 'dishes', exists: true }] },
    { id: 'live', path: '/health/live', status: 200 },
    { id: 'trails', path: '/trails.json', status: 200, json: [{ path: 'trails', exists: true }] },
  ],
};

export const meta = { invariant: ['dishes-list'] };
