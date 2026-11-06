import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Every runtime dependency is bundled at startup, for the browser and the SSR worker: one first imported
// mid-session makes Vite re-bundle, and a page rendered meanwhile on the server loads a second React.
// Not listed: React itself, the TanStack Start/Router framework (its plugin bundles it) and build-time plugins.
const NOT_PREBUNDLED = new Set(["react", "react-dom", "@tanstack/react-start", "@tanstack/react-router", "@tanstack/react-router-ssr-query", "tailwindcss-animate"]);
const { dependencies } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const PREBUNDLE = Object.keys(dependencies).filter((name) => !NOT_PREBUNDLED.has(name));

export default defineConfig({
  // Wallet selector + near-api-js expect Node globals in the browser.
  define: { global: "globalThis" },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Self-hosted builds run under plain Node, not workerd.
      "cloudflare:workers": fileURLToPath(new URL("./src/cloudflare-workers-shim.js", import.meta.url)),
      // Wallet selector + near-api-js expect Node's Buffer in the browser.
      buffer: fileURLToPath(new URL("./node_modules/buffer/index.js", import.meta.url)),
    },
  },
  optimizeDeps: { include: PREBUNDLE },
  environments: {
    ssr: {
      optimizeDeps: { include: PREBUNDLE },
      // Source maps for the server build only, never served: they map an error's
      // stack at the app's own files. Without the sources, so the app's code
      // isn't copied into them. The browser build gets none.
      build: { sourcemap: true, rolldownOptions: { output: { sourcemapExcludeSources: true } } },
    },
  },
  plugins: [
    // No inspector: a restarted dev server would race the old one for port 9229 and crash.
    cloudflare({ viteEnvironment: { name: "ssr" }, inspectorPort: false }),
    tanstackStart({ srcDirectory: "src" }),
    react(),
  ],
});
