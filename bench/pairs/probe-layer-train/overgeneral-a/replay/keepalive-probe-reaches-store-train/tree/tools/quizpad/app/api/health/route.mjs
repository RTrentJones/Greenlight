// OVERGENERAL A applied to the needs-traffic tool: "every healthcheck and keepalive queries the
// database". Here that happens to be right: the keepalive already reads keepalive_probe, and the
// health route reads it too.
import { supabase } from '../../../lib/supabase.mjs';

export async function GET() {
  const { error } = await supabase.from('keepalive_probe').select('id').limit(1);
  return Response.json(
    { ok: !error, database: error ? 'down' : 'up' },
    { status: error ? 503 : 200 },
  );
}
