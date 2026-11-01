// GET /api/health/live — liveness. "Probes never touch the database": answers from the process.
export async function GET() {
  return Response.json({ ok: true });
}
