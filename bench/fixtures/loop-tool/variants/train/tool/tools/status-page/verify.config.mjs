// Deploy gate for status-page.
export default {
  id: 'status-smoke',
  mode: 'api',
  checks: [
    { id: 'status-renders', path: '/', status: 200, contains: '<h1>Status</h1>' },
    { id: 'live', path: '/health/live', status: 200 },
  ],
};

export const meta = { invariant: ['status-renders'] };
