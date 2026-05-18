import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: "https://paratoki.com",
  output: "static",
  integrations: [sitemap()],
});
