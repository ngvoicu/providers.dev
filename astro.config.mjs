import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

// A static site: every page is built from data/published/. The Worker in worker/ serves /api/v1/*.
export default defineConfig({
  site: "https://providers.dev",
  output: "static",
  trailingSlash: "always",
  build: { format: "directory" },
  vite: { plugins: [tailwindcss()] },
});
