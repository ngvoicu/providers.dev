import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

// Compile the shared shell and authored reference fragments only. The Worker renders public pages from the API.
export default defineConfig({
  site: "https://providers.dev",
  output: "static",
  trailingSlash: "always",
  build: { format: "directory" },
  vite: { plugins: [tailwindcss()] },
});
