// Postgres over Neon's HTTP SQL endpoint. `component` becomes the connection's application_name,
// so the database's own stats show which part of the app ran a query.
export async function sql(query, params = [], component = 'web') {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL is not set');
  const res = await fetch(new URL('/sql', base), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-application-name': `scenesmith-${component}`,
    },
    body: JSON.stringify({ query, params }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`database responded ${res.status}`);
  return (await res.json()).rows;
}
