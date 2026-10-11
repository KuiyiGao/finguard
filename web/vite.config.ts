import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const api = process.env.STEWARD_API ?? "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@contracts": fileURLToPath(new URL("../server/src/types.ts", import.meta.url)),
      // Pure, browser-safe normalizers shared with the server: every card is a Finding.
      "@findings": fileURLToPath(new URL("../server/src/findings/normalize.ts", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    fs: { allow: [".", "../server/src"] },
    proxy: { "/api": { target: api, changeOrigin: true } },
  },
  preview: {
    port: 4173,
    proxy: { "/api": { target: api, changeOrigin: true } },
  },
});
