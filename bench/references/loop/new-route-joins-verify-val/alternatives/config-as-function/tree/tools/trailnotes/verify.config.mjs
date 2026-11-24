// Deploy gate for trailnotes.
const gate = {
  id: 'trailnotes-gate',
  mode: 'api',
  checks: [
    { id: 'list-heading', path: '/', status: 200, contains: 'Trail notes' },
    { id: 'first-trail', path: '/', status: 200, contains: 'cedar-loop (6.5 km)' },
    { id: 'live', path: '/health/live', status: 200, json: [{ path: 'ok', equals: true }] },
  ],
  requireIdentity: true,
};

const feed = {
  id: 'trailnotes-feed',
  mode: 'api',
  checks: [
    { id: 'trails', path: '/trails.json', status: 200, json: [{ path: 'trails', exists: true }] },
  ],
};

export default () => [gate, feed];

export const meta = { invariant: ['list-heading', 'live'] };
