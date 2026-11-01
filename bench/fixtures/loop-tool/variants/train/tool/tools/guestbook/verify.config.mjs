// Deploy gate for guestbook.
export default {
  id: 'guestbook-smoke',
  mode: 'api',
  checks: [
    { id: 'home-renders', path: '/', status: 200, contains: '<h1>Guestbook</h1>' },
    { id: 'welcome-line', path: '/', status: 200, contains: 'class="welcome"' },
    { id: 'live', path: '/health/live', status: 200, json: [{ path: 'ok', equals: true }] },
  ],
  requireIdentity: true,
};

export const meta = { invariant: ['home-renders', 'live'] };
