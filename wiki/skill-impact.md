# Skill impact

<!-- rendered from ledger.jsonl by `greenlight wiki render`; do not edit by hand -->

## Proposals

| date | proposal | skill / outlet | patterns | path | latest stage | evidence |
|---|---|---|---|---|---|---|
| 2026-11-21 | prop-733b7d768c91 | — | — | — | no-action | owner review 2026-11-21: reject (by Claude Code session, delegated by the owner) |
| 2026-11-21 | prop-4c6ab46f720c | provider-neon (skill) | pattern/probe-touches-wrong-layer, pattern/neon-never-sleeps, pattern/keepalive-probe-misses-postgres | safety-fix | merged | candidate-accepted: claude-code-sonnet isolation/val: capability 0.00→0.00 (+0.00), replay 1/1 → pass<br>candidate-accepted: claude-code-haiku isolation/val: capability 0.00→0.00 (+0.00), replay 1/1 → pass<br>owner review 2026-11-21: accept (by Claude Code session, delegated by the owner) |
| 2026-11-19 | prop-8961760898c6 | provider-neon (skill) | pattern/probe-touches-wrong-layer, pattern/neon-never-sleeps, pattern/keepalive-probe-misses-postgres | safety-fix | candidate-rejected | candidate-rejected: claude-code-sonnet isolation/val: capability 0.00→0.00 (+0.00), replay 1/1 → pass<br>candidate-rejected: claude-code-haiku isolation/val: capability 0.00→0.00 (+0.00), replay 1/1 → fail<br>owner review 2026-11-20: reject (by Claude Code session, delegated by the owner) |
| 2026-11-19 | prop-9c74a7769477 | greenlight-wiki (skill) | pattern/probe-touches-wrong-layer | standard | merged | candidate-accepted: claude-code-sonnet isolation/val: capability 0.00→0.70 (+0.70, p=0.000881834215167548), replay 0/0 → pass<br>candidate-accepted: claude-code-haiku isolation/val: capability 0.00→0.50 (+0.50, p=0.011904761904761904), replay 0/0 → pass<br>owner review 2026-11-19: accept |
| 2026-11-19 | prop-e817d701446f | greenlight-wiki (skill) | pattern/probe-touches-wrong-layer, pattern/keepalive-probe-misses-postgres, pattern/neon-never-sleeps | standard | candidate-rejected | candidate-rejected: claude-code-sonnet isolation/val: capability 0.00→0.60 (+0.60, p=0.001984126984126984), replay 1/1 → pass<br>candidate-rejected: claude-code-haiku isolation/val: capability 0.00→0.40 (+0.40, p=0.023809523809523808), replay 0/1, 1 regressed → fail<br>owner review 2026-11-19: reject |
| 2026-11-19 | prop-5b359b1ae601 | greenlight-wiki (skill) | pattern/probe-touches-wrong-layer | standard | candidate-rejected | candidate-rejected: claude-code-sonnet isolation/val: capability 0.00→0.50 (+0.50, p=0.1), replay 1/1 → fail<br>candidate-rejected: claude-code-haiku isolation/val: capability 0.00→0.17 (+0.17, p=0.5), replay 1/1 → pass<br>owner review 2026-11-19: reject |
| 2026-11-18 | prop-7f23497cfb29 | greenlight-wiki (skill) | pattern/probe-touches-wrong-layer | standard | candidate-rejected | candidate-rejected: claude-code-sonnet isolation/val: capability 0.00→0.50 (+0.50, p=0.05), replay 1/1 → fail<br>candidate-rejected: claude-code-haiku isolation/val: capability 0.00→0.00 (+0.00, p=1), replay 1/1 → fail<br>owner review 2026-11-19: reject |

## Controls

| date | proposal | skill / outlet | patterns | path | latest stage | evidence |
|---|---|---|---|---|---|---|
| 2026-11-21 | control-probe-layer-overgeneral-01496bdb | provider-neon (skill) | pattern/probe-touches-wrong-layer, pattern/keepalive-probe-misses-postgres, pattern/neon-never-sleeps | standard | candidate-rejected | candidate-rejected: claude-code-sonnet isolation/val: capability 0.00→0.00 (+0.00), replay 0/1, 1 regressed → fail<br>candidate-rejected: claude-code-haiku isolation/val: capability 0.00→0.00 (+0.00), replay 0/1, 1 regressed → fail<br>owner review 2026-11-21: reject (by Claude Code session, delegated by the owner) |
| 2026-11-21 | control-probe-layer-overgeneral-86a7058e | deploy-verify-promote (skill) | pattern/probe-touches-wrong-layer, pattern/keepalive-probe-misses-postgres, pattern/neon-never-sleeps | standard | candidate-rejected | candidate-rejected: claude-code-sonnet isolation/val: capability 1.00→1.00 (+0.00, p=1), replay 1/1 → fail<br>candidate-rejected: claude-code-haiku isolation/val: capability 0.50→0.50 (+0.00, p=0.75), replay 1/1 → fail<br>owner review 2026-11-21: reject (by Claude Code session, delegated by the owner) |
