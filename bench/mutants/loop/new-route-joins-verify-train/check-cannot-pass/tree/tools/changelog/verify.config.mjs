// Deploy gate for changelog.
export default {
  id: 'changelog-smoke',
  mode: 'api',
  checks: [
    { id: 'page-renders', path: '/', status: 200, contains: '<h1>Changelog</h1>' },
    { id: 'latest-release-listed', path: '/', status: 200, contains: '<b>1.4.0</b>' },
    { id: 'releases-feed', path: '/releases.json', status: 200, contains: '"no-such-entry"' },
    { id: 'live', path: '/health/live', status: 200, json: [{ path: 'ok', equals: true }] },
  ],
  requireIdentity: true,
};

export const meta = { invariant: ['page-renders', 'live'] };
