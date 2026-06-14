/** Stub — the real adopt flow lands in Phase 9 (migrate BAMCP + HeistMind). */
export async function adoptCommand(): Promise<void> {
  console.log(`greenlight adopt — onboard an EXISTING tool into the harness without rewriting it:
  adds a manifest entry (adopted: true) + verify.config.ts + CI wiring, and imports
  infra by reference. App code is left untouched.

Lands in Phase 9 (greenlight-v1.md §8/§16). For now, hand-add a manifest entry and a
verify.config.ts, then use \`greenlight verify\`.`);
}
