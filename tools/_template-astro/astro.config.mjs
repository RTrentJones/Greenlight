import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';

// `site` is injected from the manifest domain at build time (SITE_URL); the default
// keeps the template generic — no real domain (seam rule 15.2.1).
export default defineConfig({
  site: process.env.SITE_URL ?? 'https://example.dev',
  integrations: [sitemap()],
});
