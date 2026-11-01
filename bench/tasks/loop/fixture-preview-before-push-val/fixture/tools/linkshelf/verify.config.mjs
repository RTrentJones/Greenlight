// Deploy gate for linkshelf.
export default {
  id: 'linkshelf-api',
  mode: 'api',
  checks: [{ id: 'links-list', path: '/', status: 200, json: [{ path: 'links', exists: true }] }],
};

export const meta = { invariant: ['links-list'] };
