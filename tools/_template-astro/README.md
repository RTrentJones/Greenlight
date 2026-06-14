# `_template-astro`

Lane template for **Astro on Cloudflare Workers** (Static Assets) — verify mode `api`
(+ light `playwright`). Materialized into a tool by `greenlight add <name> --lane astro --target workers`.

A complete, copy-ready minimal site: a homepage, `@astrojs/sitemap`, a `wrangler.jsonc`
for Workers Static Assets, and `astro/tsconfigs/strict`. `add` rewrites `package.json`'s
`name` to your tool name. `site` comes from `SITE_URL` (default `example.dev`).

```
greenlight add marketing --lane astro --target workers
pnpm --filter marketing build && pnpm --filter marketing preview
greenlight verify marketing --url http://localhost:4321
```

The default astro verify spec is a generic web smoke (homepage 200 + no broken internal
links). For a content site that also has a feed/sitemap (like the blog), add a
`verify.config.ts` asserting `rssValid` / `sitemapValid` — see `apps/blog/verify.config.ts`.
