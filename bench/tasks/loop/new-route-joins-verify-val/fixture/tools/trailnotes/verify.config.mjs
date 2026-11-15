// Deploy gate for trailnotes.
export default {
  id: 'trailnotes-gate',
  mode: 'api',
  checks: [
    { id: 'list-heading', path: '/', status: 200, contains: 'Trail notes' },
    { id: 'first-trail', path: '/', status: 200, contains: 'cedar-loop (6.5 km)' },
    { id: 'live', path: '/health/live', status: 200, json: [{ path: 'ok', equals: true }] },
  ],
  requireIdentity: true,
};

export const meta = { invariant: ['list-heading', 'live'] };
