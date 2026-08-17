import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import fs from "node:fs";
import path from "node:path";

/**
 * content collection の記事から「パス -> lastmod」のマップを作る。
 * astro.config.mjs からは astro:content を import できないため、
 * frontmatter を直接読んで publishDate / updatedDate を取り出す。
 */
const buildLastmodMap = () => {
  const map = new Map();
  const collections = [
    { dir: "src/content/blog", base: "/blog" },
    { dir: "src/content/series", base: "/series" },
  ];

  for (const { dir, base } of collections) {
    const absDir = new URL(`${dir}/`, import.meta.url);
    if (!fs.existsSync(absDir)) continue;
    for (const file of fs.readdirSync(absDir)) {
      if (!file.endsWith(".md")) continue;
      const raw = fs.readFileSync(new URL(file, absDir), "utf-8");
      const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!fm) continue;
      const pick = (key) => {
        const m = fm[1].match(new RegExp(`^${key}:\\s*["']?([0-9T:+\\-.Z ]+?)["']?\\s*$`, "m"));
        return m ? m[1].trim() : undefined;
      };
      const lastmod = pick("updatedDate") ?? pick("publishDate");
      if (!lastmod) continue;
      const slug = path.basename(file, ".md");
      map.set(`${base}/${slug}/`, new Date(lastmod).toISOString());
    }
  }
  return map;
};

const lastmodMap = buildLastmodMap();

export default defineConfig({
  site: "https://paratoki.com",
  output: "static",
  integrations: [
    sitemap({
      serialize(item) {
        const pathname = new URL(item.url).pathname;
        const lastmod = lastmodMap.get(pathname);
        // collection を持たない静的ページには lastmod を付けない
        if (lastmod) item.lastmod = lastmod;
        return item;
      },
    }),
  ],
});
