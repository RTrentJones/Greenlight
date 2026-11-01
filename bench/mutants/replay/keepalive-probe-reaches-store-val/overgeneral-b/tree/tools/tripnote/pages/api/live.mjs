// GET /api/live — liveness. "Probes never touch the database": answers from the process.
export default function handler(_req, res) {
  res.status(200).json({ ok: true });
}
