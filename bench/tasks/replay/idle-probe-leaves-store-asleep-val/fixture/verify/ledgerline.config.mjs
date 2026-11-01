// Deploy gate for ledgerline: the API answers and reaches its database.
export default {
  id: 'ledgerline-api',
  mode: 'api',
  checks: [
    { id: 'service-info', path: '/', status: 200, contains: 'ledgerline' },
    {
      id: 'store-reachable',
      path: '/health',
      status: 200,
      json: [{ path: 'store', equals: 'ok' }],
    },
  ],
};

export const meta = { invariant: ['service-info', 'store-reachable'] };
