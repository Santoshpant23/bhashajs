import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

// https://astro.build/config
export default defineConfig({
  site: "https://bhashajs.com",
  integrations: [sitemap()],
  build: {
    inlineStylesheets: "auto",
  },
});
