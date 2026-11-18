import { defineConfig } from "vite";
import { createHandler } from "./server.mjs";
import { createClaude } from "./lib/claude.mjs";
import { createExa } from "./lib/exa.mjs";
import { createCommons } from "./lib/commons.mjs";

// Dev only: serve the /api routes from the same handler as production.
function apiPlugin() {
  return {
    name: "iceberg-api",
    apply: "serve",
    configureServer(server) {
      try { process.loadEnvFile(); } catch {}
      const handler = createHandler({ claude: createClaude(), exa: createExa(), commons: createCommons() });
      server.middlewares.use((req, res, next) => {
        if (req.url && req.url.startsWith("/api/")) {
          Promise.resolve(handler(req, res)).catch((err) => {
            if (!res.headersSent) res.statusCode = 500;
            res.end(String(err && err.message || err));
          });
        } else next();
      });
    },
  };
}

export default defineConfig({
  root: "web",
  plugins: [apiPlugin()],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    modulePreload: { polyfill: false },
  },
});
