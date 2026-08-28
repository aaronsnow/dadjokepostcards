import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const notFoundPath = path.resolve(__dirname, "public/404.html");

// NOTE: production no longer runs `vite preview` at all — see the
// "Production 404 handling" section of the README. Railway's Railpack
// builder serves the built dist/ folder directly via its own Caddy
// instance now (frontend/Caddyfile handles the actual custom-404 logic
// in production; see that file for how). This custom404Plugin only
// matters for `npm run dev` and `npm run preview` now — local testing,
// not the real deploy. Left in for that reason, not because it does
// anything in production anymore.
//
// Neither Vite's dev server nor its (now-local-only) preview server has
// any built-in convention for a custom 404 page — that's a static-*host*
// feature (Netlify, GitHub Pages, and now, via Caddyfile, Railway), not
// something Vite itself provides. appType:"mpa" below already makes an
// unmatched path return a correct 404 STATUS CODE instead of silently
// serving the homepage — but with an empty body.
//
// This wraps res.end() so that whenever anything downstream ultimately
// finishes a request with a 404 status and no body, we substitute our
// branded page instead. This is deliberately NOT done by registering a
// middleware that runs "after" Vite's internal ones (the documented
// return-a-function pattern) — that seemed like the obvious approach, but
// Vite's own "/" -> index.html resolution turned out to happen even later
// than that hook fires, so a naive catch-all placed there ends up
// intercepting the homepage itself, not just genuinely missing pages.
// Patching res.end() sidesteps the ordering question entirely: it only
// ever fires for requests that some other part of the stack already
// decided were a real, empty 404.
function custom404Plugin() {
  function attachOverride(req, res, next) {
    const originalEnd = res.end.bind(res);
    res.end = (chunk, ...args) => {
      const hasBody = chunk && chunk.length > 0;
      if (res.statusCode === 404 && !hasBody) {
        fs.readFile(notFoundPath, (err, data) => {
          if (err || res.headersSent) return originalEnd(chunk, ...args);
          res.setHeader("Content-Type", "text/html");
          originalEnd(data);
        });
        return;
      }
      return originalEnd(chunk, ...args);
    };
    next();
  }
  return {
    name: "custom-404",
    configureServer(server) {
      server.middlewares.use(attachOverride);
    },
    configurePreviewServer(server) {
      server.middlewares.use(attachOverride);
    },
  };
}

export default defineConfig({
  plugins: [react(), custom404Plugin()],
  // This app has no client-side router — it's one page driven by internal
  // state, plus terms.html as a second real static page. Vite's default
  // ("spa") silently serves index.html for ANY unmatched path (including a
  // genuinely missing file, like a typo'd asset URL), which is wrong here.
  // "mpa" makes unmatched paths return a real 404 instead (see
  // custom404Plugin above for what fills in that 404's response body).
  appType: "mpa",
  preview: {
    host: true,
    allowedHosts: true,
  },
});
