import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: __dirname,
  plugins: [react(), tailwindcss()],
  server: {
    host: "0.0.0.0",
  },
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
  },
});
