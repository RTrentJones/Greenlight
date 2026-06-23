# Phase 2 — The blog (first loop subject) + the real Workers adapter

> **Parent:** [greenlight-v1.md](greenlight-v1.md) §16 Phase 2. **Goal:** prove the deploy → verify loop on a real, greenfield artifact — an Astro blog on Cloudflare Workers — and stand up the first real `workers` deploy adapter.

## Objective

1. `apps/blog` — a real Astro site (content collections + MDX, RSS, sitemap, sample posts), static output deployed to **Cloudflare Workers Static Assets** (room to add a dynamic KV endpoint later without replatforming — §9). `data: none`.
2. **Real `workers` adapter** — `build` runs the tool's build; `deploy` runs `wrangler deploy`; `url`/`teardown` per the contract. Deterministic `url()` already done in Phase 1.
3. **Prove the web loop** — build the blog, serve it locally, run the `verify` harness against it (routes 200, RSS + sitemap valid, no broken internal links). This exercises the real artifact through the real harness.

## What's verifiable here vs. needs cloud creds

- **Verifiable now (no creds):** `astro build` (real), local serve via `astro preview`, and `greenlight verify --url <localhost>` against it. This is the loop proof.
- **Needs Cloudflare creds (deferred to `greenlight init`, Phase 6 / Terraform Phase 5):** the actual `wrangler deploy` to beta/prod and DNS/custom-domain wiring. The adapter implements it; it throws a clear auth error without creds.

## Blog shape

- `output: static` (default); Workers serves the built `dist/` as static assets via `wrangler` `assets`.
- `site` comes from `SITE_URL` env, default `https://example.dev` — keeps the framework blog generic (seam rule 15.2.1; `apps/` is now seam-scanned).
- Content collection `blog` (glob loader), 2 sample MDX posts; `/` lists posts; `/posts/<id>` renders; `/rss.xml`; sitemap via `@astrojs/sitemap`.

## Adapter changes

- `AdapterContext` gains `name?` (undefined = apex/blog); `url(env)` / `teardown(env)` drop the redundant name param (it's in context now).
- `workers` adapter: real `build` (`pnpm run build` in the tool dir) + `deploy` (`wrangler deploy --env <env>`), returning the deterministic `url(env)`. `teardown` stays stubbed (not on the Phase 2 path).

## CLI changes

- `greenlight verify <name>` gains `--url <url>` to point at a local/preview server (skips manifest URL resolution) — used to prove the loop locally.
- `defaultSpec` upgraded: `astro` → routes 200 + `rssValid` + `sitemapValid` + `noBrokenInternalLinks`; `next` → homepage 200; `mcp` → handshake/list.

## Ordered tasks

1. `docs/phase-2-plan.md` (this), add `apps/*` to the workspace, add `apps` to the seam scan.
2. Scaffold `apps/blog` (Astro + MDX + sitemap + RSS + posts + wrangler config).
3. Refactor adapters (`name` in context) + implement the real `workers` build/deploy.
4. CLI: `--url` override + per-lane `defaultSpec`.
5. Build the blog, serve locally, run `verify` against it — capture a passing report.
6. `pnpm run check-all` green + commit.

## Acceptance

- `astro build` produces a static `dist/` with `/`, `/posts/<id>`, `/rss.xml`, `/sitemap-index.xml`.
- `greenlight verify blog --url http://localhost:<port>` passes (200s, RSS, sitemap, no broken links) against the locally-served build — **the web loop is proven on a real artifact**.
- The `workers` adapter's `build`/`deploy` are implemented (deploy gated on CF creds).
- `pnpm run check-all` green; seam now covers `apps/`.
