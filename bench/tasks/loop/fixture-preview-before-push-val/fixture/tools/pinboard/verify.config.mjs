// Deploy gate for pinboard.
export default {
  id: 'pinboard-api',
  mode: 'api',
  checks: [
    { id: 'pins-list', path: '/pins', status: 200, json: [{ path: 'pins', exists: true }] },
    { id: 'empty-state', path: '/pins', status: 200, json: [{ path: 'message', exists: true }] },
    { id: 'live', path: '/health/live', status: 200 },
  ],
  requireIdentity: true,
};

export const meta = { invariant: ['pins-list', 'live'] };
