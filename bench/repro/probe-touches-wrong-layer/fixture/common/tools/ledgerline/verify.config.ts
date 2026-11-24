// Deploy gate for ledgerline (C2 standard ids, vision 09 §2): `live` is the process-only route
// every probe must use; `ready` is the store-querying readiness route, for verify only.
export default {
  id: 'ledgerline-api',
  mode: 'api',
  checks: [
    { id: 'live', path: '/health/live', status: 200 },
    { id: 'ready', path: '/health', status: 200, json: [{ path: 'ok', equals: true }] },
  ],
};

export const meta = { invariant: ['live', 'ready'] };
