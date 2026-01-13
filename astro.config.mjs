// @ts-check
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import cloudflare from "@astrojs/cloudflare";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: 'https://ekselera.com',
  output: 'server',
  base: '',
  integrations: [sitemap()],
  adapter: cloudflare(),
  vite: {
    plugins: [tailwindcss()],
  },
});