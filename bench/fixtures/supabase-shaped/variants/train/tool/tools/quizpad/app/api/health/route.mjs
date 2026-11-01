// GET /api/health — readiness: the app is up and Supabase answers a query. Used by verify.
import { supabase } from '../../../lib/supabase.mjs';

export async function GET() {
  const { error } = await supabase.from('quizzes').select('id').limit(1);
  return Response.json(
    { ok: !error, database: error ? 'down' : 'up' },
    { status: error ? 503 : 200 },
  );
}
