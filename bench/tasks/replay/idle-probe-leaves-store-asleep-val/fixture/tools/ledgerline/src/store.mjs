// Postgres over Neon's HTTP SQL endpoint. `role` becomes the connection's application_name.
export async function query(text, values = [], role = 'api') {
  const base = process.env.STORE_URL;
  if (!base) throw new Error('STORE_URL is not set');
  const res = await fetch(new URL('/sql', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-application-name': `ledgerline-${role}` },
    body: JSON.stringify({ query: text, params: values }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`store responded ${res.status}`);
  return (await res.json()).rows;
}
