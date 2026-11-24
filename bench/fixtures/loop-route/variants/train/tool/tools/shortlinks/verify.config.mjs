// Deploy gate for shortlinks.
export default {
  id: 'shortlinks-smoke',
  mode: 'api',
  checks: [
    { id: 'list-renders', path: '/', status: 200, contains: '<h1>Short links</h1>' },
    { id: 'live', path: '/health/live', status: 200 },
  ],
};

export const meta = { invariant: ['list-renders'] };
