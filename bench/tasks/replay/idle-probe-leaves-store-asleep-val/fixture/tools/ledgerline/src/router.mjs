// A tiny router: route(method, path, handler); handlers return { status, body }.
const routes = new Map();

export function route(method, path, handler) {
  routes.set(`${method} ${path}`, handler);
}

export async function dispatch(req, res) {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  const handler = routes.get(`${req.method} ${pathname}`);
  let out = { status: 404, body: { error: 'not found' } };
  if (handler) {
    try {
      out = await handler(req);
    } catch (e) {
      out = { status: 500, body: { error: e.message } };
    }
  }
  res.writeHead(out.status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(out.body));
}

export const readBody = (req) =>
  new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(b || '{}'));
      } catch {
        resolve({});
      }
    });
  });
