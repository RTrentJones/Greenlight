/**
 * Agent-lane deploy plumbing the CLI emits on `add` for a `lane: agent` tool:
 *  - `emitAgentDeployWorkflow` — the per-agent GitHub Actions workflow (KV namespace as code,
 *    deploy, Worker secrets, seed, verify). Generalizes the first agent's hand-built workflow.
 *  - `resolveCloudflareAccountId` — looks up the (non-secret) account id from the domain's zone,
 *    so `add` can commit it in wrangler.toml (the scoped API token can't auto-discover the account).
 */

/** The `.github/workflows/deploy-<name>.yml` for an agent. KV is created in-workflow (idempotent),
 * so the repo keeps the placeholder; GEMINI_API_KEY + RUN_TOKEN are GitHub secrets set on the
 * deployed Worker. Creds-guarded so a fork without the secrets skips cleanly. */
export function emitAgentDeployWorkflow(name: string, domain: string): string {
  return `name: deploy-${name}

# Agent "${name}" — a cron-triggered Cloudflare Worker (Gemini-backed). Emitted by \`greenlight add\`.
# On a push to main touching tools/${name}, or manually: deploys the Worker, sets its secrets from
# GitHub secrets, seeds the first run, and verifies. Creds-guarded (skips if the secrets are absent).
on:
  push:
    branches: [main]
    paths: ['tools/${name}/**']
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: deploy-${name}
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: jdx/mise-action@v2
      - run: pnpm install --frozen-lockfile

      - name: Check creds
        id: creds
        env:
          CF: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          GK: \${{ secrets.GEMINI_API_KEY }}
        run: |
          if [ -n "$CF" ] && [ -n "$GK" ]; then echo "have=1" >> "$GITHUB_OUTPUT"; else echo "have=0" >> "$GITHUB_OUTPUT"; fi

      - name: Deploy + Worker secrets + seed
        if: steps.creds.outputs.have == '1'
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          GEMINI_API_KEY: \${{ secrets.GEMINI_API_KEY }}
          RUN_TOKEN: \${{ secrets.RUN_TOKEN }}
        run: |
          cd tools/${name}
          # KV namespace as code: find-or-create the STATE namespace (idempotent), then inject its id
          # into wrangler.toml for this deploy. The id is non-secret + derived, so the repo keeps the
          # REPLACE_WITH_KV_NAMESPACE_ID placeholder — no manual create, no hardcoded id.
          ID=$(pnpm exec wrangler kv namespace list 2>/dev/null | jq -r '.[] | select(.title | test("${name}.*STATE")) | .id' | head -1)
          if [ -z "$ID" ] || [ "$ID" = "null" ]; then
            pnpm exec wrangler kv namespace create STATE || true
            ID=$(pnpm exec wrangler kv namespace list 2>/dev/null | jq -r '.[] | select(.title | test("${name}.*STATE")) | .id' | head -1)
          fi
          if [ -z "$ID" ] || [ "$ID" = "null" ]; then echo "::error::could not resolve the STATE KV namespace id (token needs Workers KV Storage:Edit?)"; exit 1; fi
          sed -i "s/REPLACE_WITH_KV_NAMESPACE_ID/$ID/g" wrangler.toml
          pnpm exec wrangler deploy --env prod
          printf '%s' "$GEMINI_API_KEY" | pnpm exec wrangler secret put GEMINI_API_KEY --env prod
          printf '%s' "$RUN_TOKEN" | pnpm exec wrangler secret put RUN_TOKEN --env prod
          cd ../..
          # Seed the first run (the cron is daily). Retry while the custom domain propagates.
          for i in $(seq 1 8); do
            if curl -fsS -XPOST "https://${name}.${domain}/run" -H "Authorization: Bearer $RUN_TOKEN" >/dev/null; then
              echo "seeded"; break
            fi
            echo "seed attempt $i: not ready, retrying in 10s"; sleep 10
          done

      - name: Verify
        if: steps.creds.outputs.have == '1'
        run: pnpm exec greenlight verify ${name} --env prod

      - name: Skip notice
        if: steps.creds.outputs.have != '1'
        run: echo "Missing CLOUDFLARE_API_TOKEN or GEMINI_API_KEY — ${name} deploy skipped."
`;
}

/** The (non-secret) Cloudflare account id for a domain's zone — committed in wrangler.toml so
 * wrangler doesn't call /memberships (which a scoped API token can't). Returns null on any failure
 * (no token, no zone, network) so `add` can fall back to a placeholder. */
export async function resolveCloudflareAccountId(
  domain: string,
  token: string,
): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(domain)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { result?: { account?: { id?: string } }[] };
    return data.result?.[0]?.account?.id ?? null;
  } catch {
    return null;
  }
}
