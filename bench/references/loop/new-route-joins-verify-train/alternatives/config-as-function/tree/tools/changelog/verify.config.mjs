// Deploy gate for changelog.
const gate = {
  id: 'changelog-smoke',
  mode: 'api',
  checks: [
    { id: 'page-renders', path: '/', status: 200, contains: '<h1>Changelog</h1>' },
    { id: 'latest-release-listed', path: '/', status: 200, contains: '<b>1.4.0</b>' },
    { id: 'live', path: '/health/live', status: 200, json: [{ path: 'ok', equals: true }] },
  ],
  requireIdentity: true,
};

const feed = {
  id: 'changelog-feed',
  mode: 'api',
  checks: [
    { id: 'releases-json', path: '/releases.json', status: 200, contains: '"version":"1.4.0"' },
  ],
};

export default () => [gate, feed];

export const meta = { invariant: ['page-renders', 'live'] };
