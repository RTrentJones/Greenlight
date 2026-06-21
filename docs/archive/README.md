# Archive — historical build records

These are point-in-time documents kept for provenance. They are **not** the current source of truth.

- For the **current architecture**, see [../architecture.md](../architecture.md).
- For the **spec / why**, see [../../greenlight-v1.md](../../greenlight-v1.md).

## Contents

- **`phase-0-plan.md` … `phase-9-plan.md`** — the per-phase build plans, in order. The skeleton/seam
  (Phase 0), the deploy→verify→promote loop and verify harness (Phases 1–6), packaging + the Claude
  Code plugin (Phase 7), keepalive (Phase 8), and the two planes — infra editor + validation gate —
  plus poly-repo `adopt` (Phase 9). `phase-9-plan.md` is written as a record (the code landed) and is
  the most useful single snapshot of how the system reached its current shape.
- **`greenlight-design-doc-v0.md`** — the original full, provider-agnostic vision (the north star,
  not the V1 build target). Anything V1 defers (Neon, the `hono` lane, provider-agnostic
  target-switching, standalone eject) lives here.
