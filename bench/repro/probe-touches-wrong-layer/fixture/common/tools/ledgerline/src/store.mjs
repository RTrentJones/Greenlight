// The Neon store, reached through STORE_URL. Every call wakes the scale-to-zero compute.
export async function query(sql) {
  const url = process.env.STORE_URL;
  if (!url) throw new Error('STORE_URL is not set');
  const res = await fetch(new URL('/sql', url), { method: 'POST', body: sql });
  if (!res.ok) throw new Error(`store answered ${res.status}`);
  return res.json();
}
